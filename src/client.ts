import { querySpec, queryFingerprint, parseQueryResult, type QueryFilter } from './query.js';
import { parseReadCursor, parseQueryCursor } from './cursor.js';
import { request, type APIRequestContext } from 'playwright';
import { lstat, readFile } from 'node:fs/promises';
import { WecomError, requireData } from './errors.js';
import { documentUrl, statePath } from './local.js';
import { cellsFor, parseChunk, parseJson, presentRecord, selectFields, type Chunk, type Field, type Schema } from './protocol.js';
import { dependencyCycles, normalizeFields, type NormalizedField } from './fields.js';
import { normalizeViews, type NormalizedView } from './views.js';
import { parseMemberCell, type MemberCell } from './members.js';
import type { PlanContext, PlanSheet } from './planner.js';

const DOC = 'https://doc.weixin.qq.com';
const READ_PATHS = new Set(['/api/smartsheet/reader/query_sheet_data', '/cgi-bin/online_docs/user_info', '/dop-api/opendoc', '/dop-api/get/sheet', '/api/smartsheet/reader/fetch_view_filter_spec',
  '/diskauth/get_auth_info', '/diskfile/recycle_list', '/diskfile/querytaskresult', '/diskaddr/list', '/webdisk/member_info']);

function cellText(cell: Raw | undefined) {
  if (!cell || !Array.isArray(cell.k1)) return '';
  return cell.k1.map((item: Raw) => typeof item?.k2 === 'string' ? item.k2 : '').join('');
}

function cellSelectIds(cell: Raw | undefined) {
  const ids = Array.isArray(cell?.k17) ? cell.k17 : Array.isArray(cell?.k9) ? cell.k9 : [];
  return ids.filter((id: unknown): id is string => typeof id === 'string');
}

function cellUserIds(cell: Raw | undefined) {
  return (Array.isArray(cell?.k7) ? cell.k7 : []).map((item: Raw) => typeof item?.k1 === 'string' ? item.k1 : null)
    .filter((id: string | null): id is string => Boolean(id));
}

function conditionValues(value: unknown) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object' && typeof (value as Raw).k1 === 'string') return [(value as Raw).k1];
  return [];
}

function matchesViewCondition(cell: Raw | undefined, fieldType: number, operator: number | null,
  value: unknown, dynamic: boolean, currentUid: string | null) {
  if (dynamic) {
    if (!currentUid) throw new WecomError('VIEWER_REQUIRED', '视图含动态“我”条件，但当前登录账号 uid 不可用。');
    return cellUserIds(cell).includes(currentUid);
  }
  if (fieldType === 1) {
    const text = cellText(cell);
    const target = conditionValues(value)[0] ?? '';
    return operator === 3 ? text.includes(target) : text === target;
  }
  if (fieldType === 17 || fieldType === 9) {
    const ids = cellSelectIds(cell);
    const target = conditionValues(value);
    return operator === 1 ? ids.length === target.length && target.every(id => ids.includes(id))
      : target.some(id => ids.includes(id));
  }
  if (fieldType === 7) {
    const ids = cellUserIds(cell);
    const target = conditionValues(value);
    return operator === 1 ? ids.length === target.length && target.every(id => ids.includes(id))
      : target.some(id => ids.includes(id));
  }
  if (fieldType === 2 || fieldType === 4) {
    const raw = fieldType === 2 ? cell?.k2 : Number(cell?.k4);
    const actual = typeof raw === 'number' ? raw : Number(raw);
    const target = Number(conditionValues(value)[0]);
    if (!Number.isFinite(actual) || !Number.isFinite(target)) return false;
    if (operator === 1) return actual === target;
    if (operator === 2) return actual > target;
    if (operator === 4) return actual < target;
    return false;
  }
  throw new WecomError('UNSUPPORTED_VIEW_FILTER', '此字段类型的视图筛选尚未实现本机过滤。', { field_type: fieldType });
}

function matchesViewFilter(cells: Raw, filter: NonNullable<NormalizedView['filter']>, byId: Map<string, Field>, currentUid: string | null) {
  const results = filter.conditions.map(condition => {
    const field = byId.get(condition.field_id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '视图筛选引用了不存在或不可读取的字段。', { field_id: condition.field_id });
    return matchesViewCondition(cells[condition.field_id], field.type_code, condition.operator_code,
      condition.value, condition.dynamic_viewer, currentUid);
  });
  return filter.conjunction === 'or' ? results.some(Boolean) : results.every(Boolean);
}

function sortViewRows(rows: { id: string; raw: Raw }[], sort: NormalizedView['sort'], byId: Map<string, Field>) {
  if (!sort.length) return rows;
  return [...rows].sort((left, right) => {
    for (const item of sort) {
      const field = byId.get(item.field_id);
      if (!field) continue;
      const cellLeft = left.raw?.k1?.[item.field_id];
      const cellRight = right.raw?.k1?.[item.field_id];
      let a: string | number = '';
      let b: string | number = '';
      if (field.type_code === 1) { a = cellText(cellLeft); b = cellText(cellRight); }
      else if (field.type_code === 2) { a = Number(cellLeft?.k2 ?? 0); b = Number(cellRight?.k2 ?? 0); }
      else if (field.type_code === 4) { a = Number(cellLeft?.k4 ?? 0); b = Number(cellRight?.k4 ?? 0); }
      else { a = cellText(cellLeft); b = cellText(cellRight); }
      if (a === b) continue;
      const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN');
      return item.descending ? -result : result;
    }
    return 0;
  });
}

type Raw = Record<string, any>;

export class WecomClient {
  private constructor(public readonly context: APIRequestContext, private cookies: { name: string; value: string; domain: string }[]) {}
  private schemas = new Map<string, { revision: number; schema: Schema }>();

  static async create() {
    let state: any;
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new WecomError('LOCAL_SECURITY_ERROR', '登录态必须是当前本机权限为 600 的普通文件。');
      state = JSON.parse(await readFile(statePath, 'utf8'));
      requireData(Array.isArray(state.cookies), '登录态文件结构错误。');
    } catch (error) {
      if (error instanceof WecomError) throw error;
      throw new WecomError('LOGIN_REQUIRED', '尚无可读取的本地登录态。请运行本机登录助手完成登录。');
    }
    const context = await request.newContext({ storageState: state, timeout: 30000, ignoreHTTPSErrors: false });
    return new WecomClient(context, state.cookies);
  }

  cookie(name: string) {
    return this.cookies.find(c => {
      const domain = c.domain.replace(/^\./, '');
      return c.name === name && ('doc.weixin.qq.com' === domain || 'doc.weixin.qq.com'.endsWith(`.${domain}`));
    })?.value || '';
  }

  async json(path: string, params: Record<string, unknown> = {}, data?: unknown): Promise<Raw> {
    return this.readRequest(path, params, data === undefined ? {} : { data });
  }

  async desktopRead(path: '/diskauth/get_auth_info' | '/diskfile/recycle_list' | '/diskfile/querytaskresult', form: Record<string, string>): Promise<Raw> {
    const result = await this.readRequest(path, { sid: this.cookie('wedoc_sid'), wedoc_xsrf: this.cookie('low_login_enable') }, { form });
    requireData(result.head?.ret === 0 && result.body && typeof result.body === 'object', '文档管理只读接口响应不完整。');
    return result.body;
  }

  private async readRequest(path: string, params: Record<string, unknown>, body: { data?: unknown; form?: Record<string, string> }): Promise<Raw> {
    if (!READ_PATHS.has(path)) throw new WecomError('LOCAL_SECURITY_ERROR', '请求路径不在已验证的只读接口清单中。');
    const url = new URL(path, DOC);
    for (const [k, v] of Object.entries({ ...params, xsrf: this.cookie('TOK') })) if (v !== undefined) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await this.context.fetch(url.href, { method: Object.keys(body).length ? 'POST' : 'GET', ...body,
        headers: { Referer: `${DOC}/`, Accept: 'application/json' }, maxRedirects: 0 });
    } catch { throw new WecomError('API_ERROR', '企业微信接口连接失败或超时。', { endpoint: path }); }
    try {
      if (response.status() === 401) throw new WecomError('AUTH_EXPIRED', '网页登录态已过期，请重新运行登录助手。');
      if (response.status() === 403) throw new WecomError('ACCESS_DENIED', '当前账号无权读取此文档或接口。');
      if (response.status() >= 300 && response.status() < 400) throw new WecomError('AUTH_REDIRECT', '接口重定向已被阻止，请重新确认登录态。');
      if (!response.ok()) throw new WecomError('API_ERROR', '企业微信接口返回 HTTP 错误。', { endpoint: path, http_status: response.status() });
      if (!response.headers()['content-type']?.includes('application/json')) throw new WecomError('PARSE_ERROR', '接口返回了网页或非 JSON 内容，没有当作文档数据。', { endpoint: path });
      const json = parseJson(await response.text(), '接口响应');
      const code = json.retcode ?? json.head?.ret ?? json.cgicode;
      if ([-20002, 12100].includes(code)) throw new WecomError('AUTH_EXPIRED', '网页登录态无效或已过期，请重新运行登录助手。');
      if (code !== undefined && code !== 0) throw new WecomError('API_ERROR', '企业微信接口返回业务错误。', { endpoint: path, business_code: code });
      return json;
    } finally { await response.dispose(); }
  }

  async checkSession() {
    const result = await this.json('/cgi-bin/online_docs/user_info', {}, {});
    if (result.retcode !== 0 || result.login !== true || result.expired !== 0) throw new WecomError('AUTH_EXPIRED', '网页登录态未通过真实用户接口验证。');
  }

  async chunk(docId: string, sheetId: string, start: number, count: number): Promise<Chunk> {
    const json = await this.json('/dop-api/get/sheet', {
      padId: docId, subId: sheetId, startrow: start, endrow: start + count - 1,
      outformat: 1, normal: 1, nowb: 1, needSheetState: 2, optimizedVer: 2,
      chunkCellSize: 15000, enableChunkRank: 1, enablePermOpt: 0,
    });
    requireData(json.retcode === 0, '读取记录响应缺少明确的成功码。');
    const chunk = parseChunk(json.data, sheetId, start, start + count - 1);
    if (chunk.schema) this.schemas.set(`${docId}/${sheetId}`, { revision: chunk.revision, schema: chunk.schema });
    return chunk;
  }

  async schema(docId: string, chunk: Chunk): Promise<Schema> {
    const cached = this.schemas.get(`${docId}/${chunk.sheetId}`);
    if (cached?.revision === chunk.revision) return cached.schema;
    const first = await this.chunk(docId, chunk.sheetId, 0, 1);
    if (first.revision !== chunk.revision) throw new WecomError('DOCUMENT_CHANGED', '读取期间表格发生变化，请从第一页重新读取。');
    requireData(first.schema, '首页未提供字段结构。');
    return first.schema;
  }

  async openDocument(input: string) {
    const doc = documentUrl(input);
    await this.checkSession();
    const params: Raw = { id: doc.id, normal: 1, noEscape: 1, outformat: 1, startrow: 0, endrow: 0,
      supportOptimizedVer: 2, enableSmartsheetSplit: 1, enableChunkRank: 1 };
    for (const key of ['scode', 'tab', 'viewId']) if (doc.url.searchParams.has(key)) params[key] = doc.url.searchParams.get(key);
    const open = await this.json('/dop-api/opendoc', params);
    if (open.clientVars?.privilegeAttribute?.can_read === 0) throw new WecomError('ACCESS_DENIED', '当前账号没有此文档的读取权限。');
    if (typeof open.padType === 'string' && open.padType !== 'smartsheet') throw new WecomError('UNSUPPORTED_TYPE', '服务端确认该文档不是智能表格。');
    requireData(open.padType === 'smartsheet', '服务端响应未确认文档类型。');
    requireData(open.clientVars?.privilegeAttribute?.can_read === 1, '文档响应未明确授予读取权限。');
    const directory = open.clientVars?.collab_client_vars?.header?.[0]?.d;
    requireData(Array.isArray(directory) && directory.every((s: Raw) => typeof s.id === 'string' && typeof s.type === 'string'), '缺少完整的子表目录。');
    return { doc, open, directory: directory as Raw[] };
  }

  async structure(input: string, sheetId?: string) {
    const { doc, open, directory } = await this.openDocument(input);
    const entries = directory.filter(s => s.type === 'smartsheet' && (sheetId === undefined || s.id === sheetId));
    if (sheetId !== undefined && !entries.length) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此智能表格或不可读取。');
    const filterResponse = await this.json('/api/smartsheet/reader/fetch_view_filter_spec', {
      sid: this.cookie('wedoc_sid'), wedoc_xsrf: this.cookie('low_login_enable'),
    }, { pad_id: doc.id, ret_all: true, view_items: [] });
    requireData(filterResponse.retcode === 0 && Array.isArray(filterResponse.result?.view_items), '个人视图筛选响应不完整。');
    const filters = filterResponse.result.view_items.map((v: Raw) => ({ sheetId: v.sub_id, viewId: v.view_id,
      filter: v.data ? parseJson(Buffer.from(v.data, 'base64').toString('utf8'), '个人视图筛选') : null }));
    const sheets = [];
    for (let start = 0; start < entries.length; start += 4) {
      const batch = await Promise.allSettled(entries.slice(start, start + 4).map(async entry => {
        const chunk = await this.chunk(doc.id, entry.id, 0, 1);
        const schema = await this.schema(doc.id, chunk);
        const normalizedFields = normalizeFields(schema, directory.map((s: Raw) => s.id).filter((id: unknown): id is string => typeof id === 'string'));
        const sheetFilters = filters.filter((f: Raw) => f.sheetId === entry.id);
        const personalFilters = Object.fromEntries(sheetFilters.map((f: Raw) => [f.viewId, f.filter]));
        const currentUid = typeof open.clientVars?.uin === 'string' ? open.clientVars.uin : null;
        const normalizedViews = normalizeViews(schema.raw.k4, normalizedFields, personalFilters, currentUid);
        return { id: entry.id, name: entry.name, type: entry.type, parent_id: entry.parentid || null, hidden: entry.hidden,
          revision: chunk.revision, total_records_in_table: chunk.total, fields: schema.fields,
          field_attributes: normalizedFields,
          views: schema.views.map(v => ({ ...v, personal_filter: filters.find((f: Raw) => f.sheetId === entry.id && f.viewId === v.id)?.filter || null })),
          view_configs: normalizedViews,
          dependencies: { cycles: dependencyCycles(normalizedFields) },
          capabilities: {
            field_config: 'verified_write_via_specialized_tools',
            member_cells: 'verified_write_via_specialized_tools',
            view_config: 'verified_write_via_specialized_tools',
            writes: 'verified_with_revision_checks',
          } };
      }));
      // 等待本批只读请求全部结束后再报错，避免关闭仍在使用的请求上下文；返回顺序保持目录顺序。
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        sheets.push(result.value);
      }
    }
    return { document_id: doc.id, title: open.clientVars.title || open.clientVars.padTitle,
      record_scope: 'whole_table_accessible_to_current_user', view_filter_applied: false,
      structure_scope: sheetId === undefined ? 'all_sheets' : 'single_sheet',
      note: 'wecom_read_records 按整张子表读取，wecom_query_records 仅应用显式查询条件；两者都不叠加 URL 视图筛选。服务端内容权限仍有效。',
      sheets, other_entries: directory.filter((s: Raw) => s.type !== 'smartsheet').map((s: Raw) => ({ id: s.id, name: s.name, type: s.type })) };
  }

  async queryRecords(input: string, sheetId: string, filter: QueryFilter, pageSize: number, fields?: string[], cursor?: string, includeTextFragments?: boolean) {
    const doc = documentUrl(input);
    const position = cursor ? parseQueryCursor(cursor, doc.id, sheetId) : undefined;
    const includeFragments = includeTextFragments ?? position?.include_text_fragments ?? false;
    await this.checkSession();
    const first = await this.chunk(doc.id, sheetId, 0, 1);
    if (position && position.revision !== first.revision) throw new WecomError('STALE_CURSOR', '查询期间表格版本变化，请从第一页重新查询。');
    const schema = await this.schema(doc.id, first);
    const selected = fields || position?.fields || schema.fields.map(f => f.id);
    const columns = selectFields(schema, selected);
    const spec = querySpec(schema, filter);
    const fingerprint = queryFingerprint(spec, selected);
    if (position && position.fingerprint !== fingerprint) {
      throw new WecomError('INVALID_CURSOR', '查询游标与条件或字段选择不匹配。后续页须保持相同条件和字段；fields 可省略以沿用上一页。');
    }
    const response = await this.json('/api/smartsheet/reader/query_sheet_data', {
      sid: this.cookie('wedoc_sid'), wedoc_xsrf: this.cookie('low_login_enable'),
    }, { pad_id: doc.id, sub_id: sheetId, version: first.revision, and_filter_specs: [spec],
      limit: pageSize, need_total: true, ...(position ? { cursor: position.token } : {}) });
    const result = parseQueryResult(response, sheetId, pageSize);
    const after = await this.chunk(doc.id, sheetId, 0, 1);
    if (after.revision !== first.revision) throw new WecomError('STALE_CURSOR', '查询期间表格版本变化，请从第一页重新查询。');
    const offset = (position?.offset || 0) + result.records.length;
    requireData(result.hasMore ? offset < result.total && result.nextCursor !== position?.token : offset === result.total, '筛选查询累计数量与总数不符。');
    const source = { sheetId, raw: result.raw };
    return { document_id: doc.id, sheet_id: sheetId, revision: first.revision,
      filter_applied: true, filter_execution: 'server', filter, view_filter_applied: false,
      ignored_url_view_id: doc.url.searchParams.get('viewId'), scope: 'matching_records_accessible_to_current_user',
      total_matching_records: result.total, returned_count: result.records.length,
      columns,
      records: result.records.map(row => presentRecord(source, schema, row, doc.id, selected, includeFragments)),
      text_fragments_included: includeFragments,
      has_more: result.hasMore, next_cursor: result.hasMore ? Buffer.from(JSON.stringify({ v: 4, document_id: doc.id,
        sheet_id: sheetId, revision: first.revision, fingerprint, fields: selected, offset, token: result.nextCursor,
        include_text_fragments: includeFragments })).toString('base64url') : null,
      limitations: ['只应用显式传入的条件，不叠加 URL 视图筛选。',
        'not_returned 不等同于空值，unresolved 不等同于完整派生值。'] };
  }

  async recordById(docId: string, sheetId: string, recordId: string) {
    const first = await this.chunk(docId, sheetId, 0, 1);
    const response = await this.json('/api/smartsheet/reader/query_sheet_data', {
      sid: this.cookie('wedoc_sid'), wedoc_xsrf: this.cookie('low_login_enable'),
    }, { pad_id: docId, sub_id: sheetId, version: first.revision, record_ids: [recordId], need_total: false });
    const result = parseQueryResult(response, sheetId, 1);
    // 此模式的 total 是请求 ID 数量，即使记录已删除/不可读仍可能为 1。
    requireData(result.total === 1 && !result.hasMore && result.records.every(row => row.id === recordId), '按 ID 回读返回了不匹配的记录或分页。');
    return result.records.at(0);
  }

  async readViewRecords(input: string, sheetId: string, viewId: string, pageSize: number, offset: number,
    fields?: string[], includeTextFragments = false) {
    const doc = documentUrl(input);
    await this.checkSession();
    const { open } = await this.openDocument(input);
    const currentUid = typeof open.clientVars?.uin === 'string' ? open.clientVars.uin : null;
    const structure = await this.structure(input, sheetId);
    const sheet = structure.sheets[0];
    const view = sheet.view_configs.find(candidate => candidate.id === viewId);
    if (!view) throw new WecomError('UNKNOWN_VIEW', '视图 ID 不属于此子表或不可读取。', { sheet_id: sheetId, view_id: viewId });
    let page = await this.chunk(doc.id, sheetId, 0, 200);
    const schema = await this.schema(doc.id, page);
    const firstRevision = page.revision;
    const firstTotal = page.total;
    const rows: { id: string; raw: Raw }[] = [];
    for (;;) {
      if (page.revision !== firstRevision || page.total !== firstTotal) {
        throw new WecomError('DOCUMENT_CHANGED', '按视图读取期间表格版本变化，请重新读取。');
      }
      rows.push(...page.records);
      const next = page.end + 1;
      if (next >= page.total) break;
      page = await this.chunk(doc.id, sheetId, next, 200);
    }
    const byId = new Map(schema.fields.map(field => [field.id, field]));
    const filtered = view.filter
      ? rows.filter(row => matchesViewFilter(row.raw?.k1 || {}, view.filter!, byId, currentUid))
      : rows;
    const sorted = sortViewRows(filtered, view.sort, byId);
    const selected: string[] = fields || schema.fields.map(field => field.id);
    const columns = selectFields(schema, selected);
    const pageRows = sorted.slice(offset, offset + pageSize);
    const records = pageRows.map(row => presentRecord(page, schema, row, doc.id, selected, includeTextFragments));
    const nextOffset = offset + records.length < sorted.length ? offset + records.length : null;
    return {
      document_id: doc.id, sheet_id: sheetId, sheet_name: sheet.name, revision: firstRevision,
      view: { id: view.id, name: view.name, type: view.type, filter: view.filter, sort: view.sort,
        group: view.group, hidden_fields: view.hidden_fields, viewer_dependent: view.viewer_dependent },
      total_records: firstTotal, matched_records: sorted.length, offset, returned_count: records.length,
      next_offset: nextOffset, columns, records, view_filter_applied: true,
      text_fragments_included: includeTextFragments,
      notes: [
        '筛选在本机按视图条件应用；分组只返回定义，不重排记录。',
        '动态“我”使用当前登录账号的 uid；未验证其他账号的实际结果。',
        '视图排序只对已支持的类型排序，未知类型保持服务端顺序。',
      ],
      limitations: ['只支持视图当前已解析的筛选条件；未识别运算符会返回 UNSUPPORTED_VIEW_FILTER。',
        '个人临时筛选不叠加；共享视图筛选才生效。'],
    };
  }

  async readRecords(input: string, sheetId: string, pageSize: number, fields?: string[], cursor?: string, includeTextFragments?: boolean) {
    const doc = documentUrl(input);
    const position = cursor ? parseReadCursor(cursor, doc.id, sheetId) : undefined;
    if (position && fields && JSON.stringify(fields) !== JSON.stringify(position.fields)) throw new WecomError('INVALID_CURSOR', '后续页的字段选择必须与第一页一致。');
    await this.checkSession();
    const chunk = await this.chunk(doc.id, sheetId, position?.offset || 0, pageSize);
    if (position && position.revision !== chunk.revision) throw new WecomError('STALE_CURSOR', '分页期间表格版本变化，请重新从第一页读取，避免漏行或重复行。');
    const schema = await this.schema(doc.id, chunk);
    const selected: string[] = fields || position?.fields || schema.fields.map(f => f.id);
    const columns = selectFields(schema, selected);
    const includeFragments = includeTextFragments ?? position?.include_text_fragments ?? false;
    const records = chunk.records.map(row => presentRecord(chunk, schema, row, doc.id, selected, includeFragments));
    const nextOffset = Math.min(chunk.end + 1, chunk.total);
    const hasMore = nextOffset < chunk.total;
    return { document_id: doc.id, sheet_id: sheetId, sheet_name: chunk.workbook.find(s => s.id === sheetId)?.name,
      revision: chunk.revision, scope: 'whole_table_accessible_to_current_user', view_filter_applied: false,
      ignored_url_view_id: doc.url.searchParams.get('viewId'), total_records: chunk.total,
      range: { start_index: chunk.start, end_index_exclusive: chunk.start + records.length }, ordering: 'server_chunk_order_not_ui_row_number', returned_count: records.length,
      columns, records, has_more: hasMore,
      text_fragments_included: includeFragments,
      next_cursor: hasMore ? Buffer.from(JSON.stringify({ v: 3, document_id: doc.id, sheet_id: sheetId,
        offset: nextOffset, revision: chunk.revision, fields: selected,
        include_text_fragments: includeFragments })).toString('base64url') : null,
      limitations: ['此工具不应用视图或条件筛选；条件检索请使用 wecom_query_records。', 'unresolved 表示未解析出标准值，不等同于空值，也不代表服务端仍在计算。', 'not_returned 表示接口未返回该单元格，不能单凭此状态断言为空或排除内容权限影响。', '字段选择发生在本机，网页分块接口仍会返回该页的全部字段。'] };
  }

  async close() { await this.context.dispose(); }


  private async postRead(path: '/diskaddr/list' | '/webdisk/member_info', form: FormData) {
    const url = new URL(path, DOC);
    url.searchParams.set('sid', this.cookie('wedoc_sid'));
    url.searchParams.set('wedoc_xsrf', this.cookie('low_login_enable'));
    let response;
    try {
      response = await this.context.post(url.href, { form, headers: { Referer: `${DOC}/`, Accept: 'application/json' }, maxRedirects: 0 });
    } catch { throw new WecomError('API_ERROR', '企业微信通讯录接口连接失败或超时。', { endpoint: path }); }
    try {
      if (response.status() === 401) throw new WecomError('AUTH_EXPIRED', '网页登录态已过期，请重新运行登录助手。');
      if (response.status() === 403) throw new WecomError('ACCESS_DENIED', '当前账号无权读取该通讯录接口。');
      if (response.status() >= 300 && response.status() < 400) throw new WecomError('AUTH_REDIRECT', '通讯录接口重定向已被阻止，请重新确认登录态。');
      if (!response.ok()) throw new WecomError('API_ERROR', '通讯录接口返回 HTTP 错误。', { endpoint: path, http_status: response.status() });
      if (!response.headers()['content-type']?.includes('application/json')) throw new WecomError('PARSE_ERROR', '通讯录接口返回了非 JSON 内容。', { endpoint: path });
      const body = parseJson(await response.text(), '通讯录接口响应');
      const code = body.head?.ret ?? body.retcode;
      if (code !== 0) throw new WecomError('API_ERROR', '通讯录接口返回业务错误。', { endpoint: path, business_code: code });
      return body.body || {};
    } finally { await response.dispose(); }
  }

  // 通讯录检索：先按姓名/工号/学号搜索 vid，再用 member_info 解析 uid 与展示信息。
  async searchMembers(input: string, query: string) {
    const { doc, open } = await this.openDocument(input);
    const user = open.clientVars.userInfo;
    requireData(user?.uid && user?.corp_id, '当前登录用户缺少通讯录所需的 uid 或 corp_id。');
    const selfForm = new FormData();
    selfForm.set('func', '3'); selfForm.set('docid', doc.id); selfForm.set('f', 'json'); selfForm.set('scene', '111');
    selfForm.append('id_list', JSON.stringify({ uid: String(user.uid) }));
    const selfBody = await this.postRead('/webdisk/member_info', selfForm);
    const selfMember = Array.isArray(selfBody.member) ? selfBody.member[0] : null;
    requireData(selfMember?.vid, '未能解析当前用户的 vid，无法按通讯录检索。');

    const searchForm = new FormData();
    searchForm.set('vid', String(selfMember.vid));
    searchForm.set('corp_id', String(user.corp_id));
    searchForm.set('func', '5');
    searchForm.set('search_key', query);
    const searchBody = await this.postRead('/diskaddr/list', searchForm);
    const rawMembers = Array.isArray(searchBody.list?.patch_list)
      ? searchBody.list.patch_list.map((item: Raw) => item?.member || item).filter((item: Raw) => typeof item?.vid === 'string' || typeof item?.vid === 'number')
      : [];
    const vids = [...new Set(rawMembers.map((item: Raw) => String(item.vid)))];
    if (!vids.length) return { matched_by: /^\d+$/.test(query.trim()) ? 'employee_or_student_id' as const : 'name' as const, exact: [], partial: [] };

    const infoForm = new FormData();
    infoForm.set('func', '3'); infoForm.set('docid', doc.id); infoForm.set('f', 'json'); infoForm.set('scene', '111');
    for (const vid of vids) infoForm.append('id_list', JSON.stringify({ vid }));
    const infoBody = await this.postRead('/webdisk/member_info', infoForm);
    const infos = Array.isArray(infoBody.member) ? infoBody.member : [];
    const candidates: { namespace: 'wecom_uid'; id: string; name: string; vid: string | null;
      corp_name: string | null; position: string | null; avatar_url: string | null }[] = infos.filter((info: Raw) => info && !info.invalid && info.uid).map((info: Raw) => ({
      namespace: 'wecom_uid' as const,
      id: String(info.uid),
      name: String(info.name || ''),
      vid: info.vid ? String(info.vid) : null,
      corp_name: info.corp_name || null,
      position: info.position || null,
      avatar_url: info.avatar || null,
    }));
    if (/^\d+$/.test(query.trim())) {
      return { matched_by: 'employee_or_student_id' as const, exact: candidates, partial: [] };
    }
    const normalized = query.trim().normalize('NFC');
    return {
      matched_by: 'name' as const,
      exact: candidates.filter(candidate => candidate.name.trim().normalize('NFC') === normalized),
      partial: candidates.filter(candidate => candidate.name.trim().normalize('NFC') !== normalized),
    };
  }

  async readView(input: string, sheetId: string, viewId: string) {
    const structure = await this.structure(input, sheetId);
    const sheet = structure.sheets.find(candidate => candidate.id === sheetId);
    if (!sheet) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此智能表格或不可读取。', { sheet_id: sheetId });
    const view = (sheet.view_configs as NormalizedView[]).find(candidate => candidate.id === viewId);
    if (!view) throw new WecomError('UNKNOWN_VIEW', '视图 ID 不属于此子表或不可读取。', { sheet_id: sheetId, view_id: viewId });
    return {
      document_id: structure.document_id, title: structure.title,
      sheet_id: sheet.id, sheet_name: sheet.name, revision: sheet.revision,
      view,
      scope_note: '共享/个人作用域按接口来源区分；个人临时筛选不等于共享视图配置。动态“我”已按 k35=true 写入并回读验证。',
      limitations: [
        '筛选连接符与运算符代码已用真实写入确认：连接符 1=and、2=or；运算符 1=eq、3=contains。其他运算符尚未验证。',
        '未识别的视图设置只列键名，不参与自动覆盖。',
        '看板分组与卡片字段按视图列解析；未填状态展示的原始配置仍保留为未解析。',
      ],
    };
  }

  // 规划/核对只读取指定子表的结构与记录；人员单元格按保守解析器转为身份引用。
  async planningContext(input: string, sheetIds?: string[]): Promise<PlanContext> {
    const structure = await this.structure(input);
    const requested = sheetIds?.length ? [...new Set(sheetIds)] : structure.sheets.map((sheet: Raw) => sheet.id as string);
    const known = new Map<string, Raw>(structure.sheets.map((sheet: Raw) => [sheet.id as string, sheet]));
    const missing = requested.filter(id => !known.has(id));
    if (missing.length) throw new WecomError('UNKNOWN_SHEET', '计划引用了不存在或不可读取的子表。', { sheet_ids: missing });
    const sheets: PlanSheet[] = [];
    for (const sheetId of requested) {
      const sheet = known.get(sheetId)!;
      const fields = sheet.field_attributes as NormalizedField[];
      const userFields = fields.filter(field => field.type === 'USER');
      const memberCells: Record<string, Record<string, MemberCell>> = {};
      const recordIds: string[] = [];
      let offset = 0;
      let revision: number | null = null;
      let total: number | null = null;
      for (;;) {
        const page = await this.chunk(structure.document_id, sheetId, offset, 200);
        if (revision === null) { revision = page.revision; total = page.total; }
        if (page.revision !== revision) throw new WecomError('DOCUMENT_CHANGED', '规划读取期间表格版本变化，请重新读取后再生成计划。', { sheet_id: sheetId });
        for (const row of page.records) {
          recordIds.push(row.id);
          memberCells[row.id] = {};
          const cells = cellsFor(row.raw);
          for (const field of userFields) memberCells[row.id][field.id] = parseMemberCell(cells[field.id]);
        }
        const next = page.end + 1;
        if (next >= page.total) break;
        if (next <= offset) throw new WecomError('INCOMPLETE_DATA', '规划读取分页没有前进。', { sheet_id: sheetId });
        offset = next;
      }
      if (recordIds.length !== total) throw new WecomError('INCOMPLETE_DATA', '规划读取的记录数与子表总数不一致。', {
        sheet_id: sheetId, expected: total, actual: recordIds.length });
      sheets.push({
        id: sheet.id, name: sheet.name, revision: revision!, total_records_in_table: total!,
        fields, views: sheet.view_configs as NormalizedView[], record_ids: recordIds, member_cells: memberCells,
      });
    }
    return { document_id: structure.document_id, title: structure.title, sheets };
  }
}
