import { querySpec, queryFingerprint, parseQueryResult, type QueryFilter } from './query.js';
import { parseReadCursor, parseQueryCursor } from './cursor.js';
import { request, type APIRequestContext } from 'playwright';
import { lstat, readFile } from 'node:fs/promises';
import { WecomError, requireData } from './errors.js';
import { documentUrl, statePath } from './local.js';
import { parseChunk, parseJson, presentRecord, selectFields, type Chunk, type Schema } from './protocol.js';

const DOC = 'https://doc.weixin.qq.com';
const READ_PATHS = new Set(['/api/smartsheet/reader/query_sheet_data', '/cgi-bin/online_docs/user_info', '/dop-api/opendoc', '/dop-api/get/sheet', '/api/smartsheet/reader/fetch_view_filter_spec',
  '/diskauth/get_auth_info', '/diskfile/recycle_list', '/diskfile/querytaskresult']);
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
        return { id: entry.id, name: entry.name, type: entry.type, parent_id: entry.parentid || null, hidden: entry.hidden,
          revision: chunk.revision, total_records_in_table: chunk.total, fields: schema.fields,
          views: schema.views.map(v => ({ ...v, personal_filter: filters.find((f: Raw) => f.sheetId === entry.id && f.viewId === v.id)?.filter || null })) };
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
}
