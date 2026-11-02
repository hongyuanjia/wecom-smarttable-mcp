import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { WecomClient } from './client.js';
import { documentReference, documentUrl, saveExecution } from './local.js';
import { WecomError, requireData } from './errors.js';
import { type Chunk, type Schema } from './protocol.js';
import { parseDocumentRole, parseRecyclePage } from './document-protocol.js';
import { acknowledgedClears, addColumnMutations, appendRank, columnViewsMatch, deleteColumnMutations, memberUpdateMutations, mutation, newId, uniqueIds, updateMutations, valuesMatch,
  type CellValue, type ColumnInput, type MemberChange, type Mutation, type RecordInput } from './mutations.js';
import { cellsFor, parseDerivedResult } from './protocol.js';
import { buildViewObject, compareCreateView, encodeViewFilter, encodeViewGroup, encodeViewSort, encodeViewStatistics, normalizeView, viewStatisticsMatches, VIEW_TYPE_CODES, type ViewWriteInput } from './views.js';
import { assertNoDuplicateFieldIds, compareHiddenFieldSets, compareProtectedWidths, compareRequestedWidths,
  validateUpdateFieldOrder } from './view-semantics.js';
import { normalizeFields } from './fields.js';
import { formulaFieldMutations, formulaFormatter, formulaFormatterMatches, lookupFieldMutations, relationFieldMutations, type FormulaFormatSpec, type LookupSpec, type RelationSpec } from './field-writer.js';
import { assertFormulaDefinition, assertProviderFormulaSupport, encodeProviderFormula, type FormulaExpression } from './formulas.js';

type Raw = Record<string, any>;

function derivedCellKey(cell: Raw | undefined, typeCode: number): string | null {
  if (!cell) return null;
  if (typeCode === 1) {
    const fragments = cell.k1;
    if (!Array.isArray(fragments)) return null;
    const text = fragments.map((item: Raw) => typeof item?.k2 === 'string' ? item.k2 : '').join('');
    return text.length ? text : null;
  }
  if (typeCode === 21) {
    const ids = (cell.k21?.k1 || []).map((item: Raw) => item.k3).filter((id: unknown) => typeof id === 'string');
    return ids.length ? ids.sort().join(',') : null;
  }
  if (typeCode === 18) {
    const ids = Array.isArray(cell.k18) ? cell.k18.filter((id: unknown) => typeof id === 'string') : [];
    return ids.length ? ids.sort().join(',') : null;
  }
  const value = cell[`k${typeCode}`];
  if (value === undefined || value === null || value === '') return null;
  if (typeCode === 7 && Array.isArray(value)) {
    const ids = value.map((item: Raw) => item?.k1).filter((id: unknown) => typeof id === 'string');
    return ids.length ? ids.sort().join(',') : null;
  }
  if ([9, 17].includes(typeCode) && Array.isArray(value)) return value.length ? value.slice().sort().join(',') : null;
  return String(value);
}

const FORMULA_FORMAT_NAMES = ['text', 'number', 'percent', 'currency', 'date', 'checkbox', 'email', 'progress'] as const;

function resolveFormulaFormat(format?: FormulaFormatSpec | string): Raw | undefined {
  if (format === undefined) return undefined;
  const spec: FormulaFormatSpec = typeof format === 'string'
    ? { type: format as FormulaFormatSpec['type'] }
    : format;
  if (!FORMULA_FORMAT_NAMES.includes(spec.type as typeof FORMULA_FORMAT_NAMES[number])) {
    throw new WecomError('UNSUPPORTED_FORMULA_FORMAT', '不支持的公式展示格式。', { format: spec.type });
  }
  return formulaFormatter(spec);
}
interface Target {
  doc: ReturnType<typeof documentUrl>; sheetId: string; chunk: Chunk; schema: Schema; user: Raw; actor: Raw; uid: string;
  dver: string; pver: number; recordMode: boolean; planId?: string;
}
const DOC = 'https://doc.weixin.qq.com';

export class WriteQueue {
  private pending = new Map<string, Promise<unknown>>();
  async run<T>(url: string, action: () => Promise<T>): Promise<T> {
    const key = documentUrl(url).id;
    const previous = this.pending.get(key);
    const current = (previous || Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, current);
    try { return await current; }
    finally { if (this.pending.get(key) === current) this.pending.delete(key); }
  }
}


function rawViewProperties(raw: Raw) {
  return raw[`k${raw.k32}`] || {};
}

function rawConditionSummary(condition: Raw) {
  const fieldType = condition.k31 ?? condition['31'];
  return {
    field_id: condition.k30 ?? condition['30'],
    field_type: fieldType,
    operator: condition.k32 ?? condition['32'],
    value: condition[`k${fieldType}`] ?? condition[String(fieldType)] ?? null,
    dynamic_viewer: (condition.k35 ?? condition['35']) === true,
  };
}

function rawFilterSummary(raw: Raw | null | undefined) {
  if (!raw) return null;
  const conditions = raw.k2 ?? raw['2'];
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  return { conjunction: raw.k1 ?? raw['1'], conditions: conditions.map(rawConditionSummary) };
}

function placementSummary(items: unknown) {
  if (!Array.isArray(items)) return [];
  return items.map((item: Raw) => ({ field_id: item.k1 ?? item['1'], descending: Boolean(item.k2 ?? item['2']) }));
}

function buildSemanticFieldDelta(type: number, rawConfig: Raw | undefined, patch: Raw): Raw {
  const delta: Raw = {};
  if (patch.number) {
    if (type !== 2) throw new WecomError('INVALID_ARGUMENT', 'number 属性只能用于数字字段。');
    if (patch.number.decimal_places !== undefined) delta['1'] = patch.number.decimal_places;
    if (patch.number.use_separator !== undefined) delta['2'] = patch.number.use_separator;
  }
  if (patch.date) {
    if (type !== 4) throw new WecomError('INVALID_ARGUMENT', 'date 属性只能用于日期字段。');
    if (patch.date.format !== undefined) delta['1'] = patch.date.format;
    if (patch.date.auto_fill !== undefined) delta['2'] = patch.date.auto_fill;
  }
  if (patch.select) {
    if (![9, 17].includes(type)) throw new WecomError('INVALID_ARGUMENT', 'select 属性只能用于单选或多选字段。');
    if (patch.select.allow_multiple !== undefined) {
      if (type === 17 && patch.select.allow_multiple) throw new WecomError('INVALID_ARGUMENT', '单选字段不能开启多选。');
      if (type === 9 && !patch.select.allow_multiple) throw new WecomError('INVALID_ARGUMENT', '多选字段不能关闭多选。');
      delta['1'] = patch.select.allow_multiple;
    }
    if (patch.select.quick_add !== undefined) delta['2'] = patch.select.quick_add;
    if (patch.select.options !== undefined) {
      const existing = Array.isArray(rawConfig?.k3) ? rawConfig.k3.map((option: Raw) => ({ '1': option.k1, '2': option.k2, '3': option.k3 })) : [];
      for (const item of patch.select.options) {
        if (item.id) {
          const found = existing.find((option: Raw) => option['1'] === item.id);
          if (!found) throw new WecomError('UNKNOWN_OPTION', '选项 ID 不属于此字段。', { option_id: item.id });
          if (item.name !== undefined) found['2'] = item.name;
          if (item.color !== undefined) found['3'] = item.color;
        } else {
          if (!item.name) throw new WecomError('INVALID_ARGUMENT', '新增选项需要 name。');
          const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
          let id = '';
          do { id = `o${Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('')}`; }
          while (existing.some((option: Raw) => option['1'] === id));
          existing.push({ '1': id, '2': item.name, '3': item.color ?? 11 });
        }
      }
      delta['3'] = existing;
    }
  }
  if (patch.text) {
    if (type !== 1) throw new WecomError('INVALID_ARGUMENT', 'text 属性只能用于文本字段。');
    if (patch.text.rich_text === true) delta['9'] = {};
    if (patch.text.rich_text === false) delta['9'] = null;
  }
  if (patch.url) {
    if (type !== 8) throw new WecomError('INVALID_ARGUMENT', 'url 属性只能用于链接字段。');
    if (patch.url.display_style !== undefined) delta['1'] = patch.url.display_style;
  }
  if (patch.progress) {
    if (type !== 14) throw new WecomError('INVALID_ARGUMENT', 'progress 属性只能用于进度字段。');
    if (patch.progress.decimal_places !== undefined) delta['1'] = patch.progress.decimal_places;
    if (patch.progress.percentage !== undefined) delta['4'] = patch.progress.percentage ? 0 : 1;
    if (patch.progress.min !== undefined || patch.progress.max !== undefined) {
      const range = Array.isArray(rawConfig?.k5) ? [...rawConfig.k5] : [0, 1];
      if (patch.progress.min !== undefined) range[0] = patch.progress.min;
      if (patch.progress.max !== undefined) range[1] = patch.progress.max;
      if (!(range[0] < range[1])) throw new WecomError('INVALID_ARGUMENT', '进度范围必须 min < max。');
      delta['5'] = range;
    }
  }
  if (patch.checkbox) {
    if (type !== 3) throw new WecomError('INVALID_ARGUMENT', 'checkbox 属性只能用于复选框字段。');
    if (patch.checkbox.default_checked !== undefined) delta['1'] = patch.checkbox.default_checked;
  }
  if (!Object.keys(delta).length) throw new WecomError('INVALID_ARGUMENT', '字段属性补丁没有可写入的变更。');
  return delta;
}

function semanticFieldConfigMatches(type: number, rawConfig: Raw | undefined, patch: Raw) {
  const actual = rawConfig || {};
  if (patch.number) {
    if (patch.number.decimal_places !== undefined && actual.k1 !== patch.number.decimal_places) return false;
    if (patch.number.use_separator !== undefined && actual.k2 !== patch.number.use_separator) return false;
  }
  if (patch.date) {
    if (patch.date.format !== undefined && actual.k1 !== patch.date.format) return false;
    if (patch.date.auto_fill !== undefined && actual.k2 !== patch.date.auto_fill) return false;
  }
  if (patch.select) {
    if (patch.select.allow_multiple !== undefined && actual.k1 !== patch.select.allow_multiple) return false;
    if (patch.select.quick_add !== undefined && actual.k2 !== patch.select.quick_add) return false;
    if (patch.select.options !== undefined) {
      const options = Array.isArray(actual.k3) ? actual.k3 : [];
      for (const item of patch.select.options) {
        if (item.id) {
          const found = options.find((option: Raw) => option.k1 === item.id);
          if (!found) return false;
          if (item.name !== undefined && found.k2 !== item.name) return false;
          if (item.color !== undefined && found.k3 !== item.color) return false;
        } else {
          const found = options.find((option: Raw) => option.k2 === item.name);
          if (!found) return false;
          if (item.color !== undefined && found.k3 !== item.color) return false;
        }
      }
      if (Array.isArray(rawConfig?.k3)) {
        for (const original of rawConfig.k3) {
          if (!options.some((option: Raw) => option.k1 === original.k1 && option.k2 === original.k2)) return false;
        }
      }
    }
  }
  if (patch.url && patch.url.display_style !== undefined && actual.k1 !== patch.url.display_style) return false;
  if (patch.progress) {
    if (patch.progress.decimal_places !== undefined && actual.k1 !== patch.progress.decimal_places) return false;
    if (patch.progress.percentage !== undefined && actual.k4 !== (patch.progress.percentage ? 0 : 1)) return false;
    if (patch.progress.min !== undefined && actual.k5?.[0] !== patch.progress.min) return false;
    if (patch.progress.max !== undefined && actual.k5?.[1] !== patch.progress.max) return false;
  }
  if (patch.checkbox && patch.checkbox.default_checked !== undefined && actual.k1 !== patch.checkbox.default_checked) return false;
  return true;
}

function rawHiddenFields(raw: Raw): string[] {
  const properties = rawViewProperties(raw);
  if (!properties || typeof properties.k5 !== 'object' || !properties.k5) return [];
  return Object.entries(properties.k5)
    .filter(([, info]) => info && typeof info === 'object' && (info as Raw).k2 === true)
    .map(([id]) => id);
}

function rawColumnOrder(raw: Raw): string[] {
  const properties = rawViewProperties(raw);
  return Array.isArray(properties?.k2) ? properties.k2.filter((id: unknown): id is string => typeof id === 'string') : [];
}

function rawWidths(raw: Raw): Record<string, number> {
  const properties = rawViewProperties(raw);
  const widths: Record<string, number> = {};
  if (properties && typeof properties.k5 === 'object' && properties.k5) {
    for (const [id, info] of Object.entries(properties.k5)) {
      if (info && typeof info === 'object' && typeof (info as Raw).k1 === 'number'
        && Number.isFinite((info as Raw).k1)) widths[id] = (info as Raw).k1;
    }
  }
  return widths;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function viewMatchesRaw(raw: Raw, expected: Raw) {
  const properties = rawViewProperties(raw);
  const expectedProperties = expected['1'];
  if (raw.k31 !== expected['31'] || raw.k32 !== expected['32'] || raw.k35 !== expected['35']) return false;
  const actualColumns = Array.isArray(properties.k2) ? properties.k2 : [];
  const expectedColumns = expectedProperties['2'] || [];
  // 服务端会按字段定义顺序重排视图列；创建时先核对可见列集合，顺序另行处理。
  if (actualColumns.length !== expectedColumns.length || !expectedColumns.every((id: string) => actualColumns.includes(id))) return false;
  const expectedGroup = expectedProperties['7'] || [];
  const expectedSort = expectedProperties['9'] || [];
  if (!sameJson(placementSummary(properties.k7), placementSummary(expectedGroup))) return false;
  if (!sameJson(placementSummary(properties.k9), placementSummary(expectedSort))) return false;
  if (!sameJson(rawFilterSummary(properties.k8), rawFilterSummary(expectedProperties['8']))) return false;
  for (const id of expectedProperties['2']) {
    const expectedWidth = expectedProperties['5']?.[id]?.['1'];
    const actualWidth = properties.k5?.[id]?.k1;
    if (expectedWidth !== undefined && actualWidth !== undefined && actualWidth !== expectedWidth) return false;
  }
  if ((properties.k10 === true) !== (expectedProperties['10'] === true)) return false;
  return true;
}

export class WecomWriter {
  constructor(private client: WecomClient, private signal: AbortSignal) {}

  private cancelled() {
    if (this.signal.aborted) throw new WecomError('WRITE_CANCELLED', '请求已取消，尚未发出写入。');
  }

  // 写请求独立于只读路径清单；发送后发生的错误均不进入登录后的自动重试。
  private async post(path: '/webdisk/create' | '/dop-api/commitchanges' | '/webdisk/file_mgr', params: Record<string, string>, form: Record<string, string>, intent: Raw) {
    this.cancelled();
    if (Buffer.byteLength(new URLSearchParams(form).toString()) > 1024 * 1024) throw new WecomError('WRITE_TOO_LARGE', '编码后的写入请求超过 1 MiB，请减小批量大小；尚未提交。');
    const url = new URL(path, DOC);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const cancel = () => { void this.client.context.dispose().catch(() => {}); };
    this.signal.addEventListener('abort', cancel, { once: true });
    let response;
    try {
      response = await this.client.context.post(url.href, { form, headers: { Referer: `${DOC}/`, Accept: 'application/json' }, maxRedirects: 0, maxRetries: 0 });
      if (!response.ok() || !response.headers()['content-type']?.includes('application/json')) throw new Error('unconfirmed response');
      const result = await response.json();
      const code = result.retcode ?? result.head?.ret;
      if (typeof code !== 'number') throw new Error('missing result code');
      if (code !== 0) throw new WecomError('WRITE_REJECTED', '企业微信拒绝了写入；没有自动重试。请先重新读取目标，再决定是否重试。', { ...intent, business_code: code, automatic_retry: false });
      return result as Raw;
    } catch (error) {
      if (error instanceof WecomError) throw error;
      throw new WecomError('WRITE_RESULT_UNKNOWN', '写入请求已发出，但无法确认结果；可能已经生效。请先读取核对，不能直接重复新增或删除。', { ...intent, may_have_written: true, automatic_retry: false });
    } finally {
      this.signal.removeEventListener('abort', cancel);
      await response?.dispose().catch(() => {});
    }
  }

  private async prepare(input: string, sheetId: string, revision: number, planId?: string): Promise<Target> {
    this.cancelled();
    const { doc, open, directory } = await this.client.openDocument(input);
    const vars = open.clientVars;
    if (vars.privilegeAttribute?.can_edit !== 1) throw new WecomError('WRITE_ACCESS_DENIED', '当前账号没有此文档的编辑权限。');
    if (!directory.some(s => s.id === sheetId && s.type === 'smartsheet')) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此智能表格。');
    const chunk = await this.client.chunk(doc.id, sheetId, 0, 200);
    if (chunk.revision !== revision) throw new WecomError('STALE_REVISION', '表格版本已变化；请重新读取并基于新内容决定修改，尚未写入。', { expected_revision: revision, current_revision: chunk.revision });
    const schema = await this.client.schema(doc.id, chunk);
    const collab = vars.collab_client_vars;
    requireData(typeof vars.uin === 'string' && typeof vars.userInfo?.fullName === 'string'
      && typeof collab.dver === 'string' && Number.isInteger(collab.pver), '网页写入所需的账号或版本元数据不完整。');
    if (collab.smartsheetPermissionInvalid) throw new WecomError('WRITE_ACCESS_DENIED', '智能表格内容权限无效，尚未写入。');
    const corp = vars.userInfo.corp_id;
    const corpId = typeof corp === 'string' && /^\d+$/.test(corp) ? Number(corp) : corp;
    const actor = { '1': vars.uin, '2': vars.userInfo.fullName, '3': vars.userInfo.userPic || '',
      '5': corpId, '6': vars.userInfo.corp_name || '', '7': vars.userInfo.fullName, '8': corpId };
    return { doc, sheetId, chunk, schema, uid: vars.uin, user: { '1': vars.uin, '2': vars.userInfo.fullName }, actor,
      dver: collab.dver, pver: collab.pver, recordMode: vars.optimizedVer >= 4, planId };
  }

  private async records(target: Target, first: Chunk, wanted?: Set<string>) {
    const rows = new Map<string, { id: string; raw: Raw }>();
    let page = first;
    for (;;) {
      this.cancelled();
      if (page.revision !== first.revision || page.total !== first.total) throw new WecomError('DOCUMENT_CHANGED', '核对记录期间表格版本变化，无法确认完整结果。');
      for (const row of page.records) rows.set(row.id, row);
      if (wanted && [...wanted].every(id => rows.has(id))) break;
      const next = page.end + 1;
      if (next >= first.total) break;
      requireData(next > page.start, '记录分页没有前进。');
      page = await this.client.chunk(target.doc.id, target.sheetId, next, 200);
    }
    return rows;
  }

  private async allRows(target: Target, sheetId: string) {
    const rows: { id: string; raw: Raw }[] = [];
    let page = await this.client.chunk(target.doc.id, sheetId, 0, 200);
    for (;;) {
      rows.push(...page.records);
      const next = page.end + 1;
      if (next >= page.total) break;
      requireData(next > page.start, '记录分页没有前进。');
      page = await this.client.chunk(target.doc.id, sheetId, next, 200);
    }
    return rows;
  }

  private async requireRecords(target: Target, ids: string[]) {
    uniqueIds(ids, '记录列表');
    const rows = await this.records(target, target.chunk, new Set(ids));
    const missing = ids.filter(id => !rows.has(id));
    if (missing.length) throw new WecomError('UNKNOWN_RECORD', '记录不存在或不可读取，尚未写入。', { record_ids: missing });
    return rows;
  }

  private async apply(target: Target, mutations: Mutation[], operation: string, affected: Raw,
    verify: (chunk: Chunk, schema: Schema, clears: ReadonlyMap<string, Set<string>>) => Promise<boolean>) {
    const intent = { document_id: target.doc.id, sheet_id: target.sheetId, operation, ...affected,
      ...(target.planId ? { plan_id: target.planId } : {}) };
    const current = await this.client.chunk(target.doc.id, target.sheetId, 0, 1);
    if (current.revision !== target.chunk.revision) throw new WecomError('STALE_REVISION', '准备修改期间表格已变化，尚未提交；请重新读取后决定修改。', { expected_revision: target.chunk.revision, current_revision: current.revision });
    const taskId = randomInt(1, 2 ** 48 - 1);
    const revision = target.chunk.revision;
    const payload = {
      common: { need_optimize: true, once_mode: true, type: 'USER_CHANGES', curRev: revision, offlineMsg: true,
        docid: target.doc.id, uid: target.uid, dver: target.dver, base_rev: revision, code_ver: 0, session_type: 0,
        gray: 0, pver: target.pver, uuId: randomUUID() },
      respective: [{ task_id: taskId, subId: target.sheetId, oSubId: false, head: false, keydata: false,
        changeSetCount: 1, changeset: JSON.stringify([mutations]) + '\n', changesetType: 'smartsheet' }],
    };
    const response = await this.post('/dop-api/commitchanges', { padId: target.doc.id, xsrf: this.client.cookie('TOK') }, { data: JSON.stringify(payload) }, intent);
    let committedRevision: number | undefined;
    try {
      const matches = response.Data?.respective?.filter((r: Raw) => r.commitId === taskId);
      requireData(Array.isArray(matches) && matches.length >= 1, '写入响应缺少当前请求的确认。');
      // 双向关联等跨表写入会在同一提交中返回目标表与反向表两条确认，必须逐条校验。
      requireData(matches.every((entry: Raw) => typeof entry.subId === 'string' && entry.revert === false && entry.need === false
        && Number.isSafeInteger(entry.newRev)), '写入确认的子表、状态或版本无效。');
      const accepted = matches.find((entry: Raw) => entry.subId === target.sheetId);
      requireData(accepted && Number.isSafeInteger(accepted.newRev) && accepted.newRev > revision, '写入确认缺少当前子表的版本。');
      // 版本号是文档级：跨表提交会连续占用多个版本，回读版本取本次提交的最大值。
      const nextRevision: number = matches.length === 1 ? accepted.newRev : Math.max(...matches.map((entry: Raw) => entry.newRev as number));
      committedRevision = nextRevision;
      if (matches.length === 1 && nextRevision !== revision + 1) throw new WecomError('WRITE_CONFLICT', '提交期间出现其他版本变化，需要重新核对。');
      if (matches.length > 1 && nextRevision < revision + 1) throw new WecomError('WRITE_CONFLICT', '跨表提交版本未前进，需要重新核对。');
      const after = await this.client.chunk(target.doc.id, target.sheetId, 0, 200);
      requireData(after.revision === committedRevision, '回读版本与提交确认不一致，需要重新核对并发变化。');
      const schema = await this.client.schema(target.doc.id, after);
      if (!await verify(after, schema, acknowledgedClears(mutations, accepted.changeset))) throw new WecomError('WRITE_MISMATCH', '重新读取的结果与请求不一致。');
      const executionId = await this.recordExecution({ status: 'verified', document_id: target.doc.id,
        ...(target.planId ? { plan_id: target.planId } : {}),
        sheet_id: target.sheetId, operation, ...affected, previous_revision: revision,
        committed_revision: committedRevision, revision: after.revision });
      return { ...intent, execution_id: executionId, status: 'verified', previous_revision: revision,
        committed_revision: committedRevision, revision: after.revision };
    } catch (error) {
      const reasonCode = error instanceof WecomError ? error.code : 'LOCAL_ERROR';
      const reasonMessage = error instanceof WecomError ? error.message : '本地错误';
      const executionId = await this.recordExecution({ status: 'not_verified', document_id: target.doc.id,
        ...(target.planId ? { plan_id: target.planId } : {}),
        sheet_id: target.sheetId, operation, ...affected, committed_revision: committedRevision,
        reason_code: reasonCode, reason_message: reasonMessage });
      throw new WecomError('WRITE_NOT_VERIFIED', '服务端已返回写入响应，但回读未能完整核对；请先检查目标，不能直接重复提交。', {
        ...intent, execution_id: executionId, committed_revision: committedRevision, reason_code: reasonCode,
        reason_message: reasonMessage, may_have_written: true, automatic_retry: false,
      });
    }
  }

  private async recordExecution(entry: Raw) {
    try { return (await saveExecution(entry)).execution_id; } catch { return null; }
  }

  async updateRecords(url: string, sheetId: string, revision: number, rows: RecordInput[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const commands = updateMutations(sheetId, target.schema, rows, target.user, target.recordMode);
    const ids = rows.map(r => r.record_id);
    await this.requireRecords(target, ids);
    return this.apply(target, commands, 'update_records', { record_ids: ids }, async (after, schema, clears) => {
      const actual = await this.records(target, after, new Set(ids));
      return rows.every(row => actual.has(row.record_id) && valuesMatch(schema, actual.get(row.record_id)!, row.values, clears.get(row.record_id)));
    });
  }

  async addRecords(url: string, sheetId: string, revision: number, values: Record<string, CellValue>[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const existing = await this.records(target, target.chunk);
    const rows = values.map(value => ({ record_id: newId('r'), values: value }));
    uniqueIds(rows.map(r => r.record_id), '新记录列表');
    if (rows.some(row => existing.has(row.record_id))) throw new WecomError('ID_COLLISION', '新记录 ID 已存在，尚未提交。');
    const maxRank = target.schema.raw.k16?.k3;
    requireData(typeof maxRank === 'string', '缺少表尾顺序标识，尚未新增记录。');
    const inserts = rows.map((row, index) => mutation(3010, { '1': sheetId, '3': { '1': row.record_id,
      '3': target.uid, '4': Date.now(), '7': { '1': appendRank(maxRank, index + 1), '2': {} } }, '4': target.user }));
    const filled = rows.filter(r => Object.keys(r.values).length);
    const updates = filled.length ? updateMutations(sheetId, target.schema, filled, target.user, target.recordMode) : [];
    const ids = rows.map(r => r.record_id);
    return this.apply(target, [...inserts, ...updates], 'add_records', { record_ids: ids }, async (after, schema, clears) => {
      if (after.total !== target.chunk.total + rows.length) return false;
      const actual = await this.records(target, after, new Set(ids));
      return rows.every(row => actual.has(row.record_id) && valuesMatch(schema, actual.get(row.record_id)!, row.values, clears.get(row.record_id)));
    });
  }

  async deleteRecords(url: string, sheetId: string, revision: number, ids: string[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    await this.requireRecords(target, ids);
    const command = mutation(3035, { '1': sheetId, '2': ids.map(id => ({ '1': id })) });
    return this.apply(target, [command], 'delete_records', { record_ids: ids }, async after => {
      if (after.total !== target.chunk.total - ids.length) return false;
      const actual = await this.records(target, after);
      return ids.every(id => !actual.has(id));
    });
  }


  async updateMemberCells(url: string, sheetId: string, revision: number, changes: MemberChange[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const ids = [...new Set(changes.map(change => change.record_id))];
    await this.requireRecords(target, ids);
    const commands = memberUpdateMutations(sheetId, changes, target.actor, target.recordMode);
    return this.apply(target, commands, 'update_member_cells', { record_ids: ids }, async (after, _schema, clears) => {
      const rows = await this.records(target, after, new Set(ids));
      return changes.every(change => {
        const row = rows.get(change.record_id);
        if (!row) return false;
        const cell = cellsFor(row.raw)[change.field_id];
        const expected = [...new Set(change.uids)].sort();
        if (!cell) return expected.length === 0 && clears.get(change.record_id)?.has(change.field_id) === true;
        if (cell.k30 !== 7) return false;
        const actual = Array.isArray(cell.k7)
          ? cell.k7.map((item: Raw) => String(item?.k1 || '')).filter(Boolean)
          : [];
        return actual.length === expected.length && expected.every(uid => actual.includes(uid));
      });
    });
  }


  async createView(url: string, sheetId: string, revision: number, patch: ViewWriteInput, planId?: string) {
    if (!patch.name) throw new WecomError('INVALID_ARGUMENT', '新建视图需要名称。');
    const target = await this.prepare(url, sheetId, revision, planId);
    const normalizedFields = normalizeFields(target.schema, [target.sheetId]);
    const normalizedViews = target.schema.views.map(view => normalizeView(view, normalizedFields));
    const comparison = compareCreateView({ patch, views: normalizedViews, fields: normalizedFields });
    if (comparison?.decision === 'skip') {
      return { status: 'noop', operation: 'create_view', document_id: target.doc.id, sheet_id: target.sheetId,
        name: patch.name, view_id: comparison.view_id, no_changes: true, previous_revision: target.chunk.revision,
        revision: target.chunk.revision,
        note: '同名视图的规范化配置与本次创建请求一致；返回已有视图，未提交写入。' };
    }
    if (comparison) {
      throw new WecomError('VIEW_CONFIG_DIFF',
        '同名视图已存在但规范化配置不同；请改用 view_id 更新，未提交写入。', {
          name: patch.name, view_id: comparison.view_id,
          differences: comparison.differences.slice(0, 20),
          difference_count: comparison.differences.length,
          required_action: { tool: 'wecom_update_view', view_id: comparison.view_id },
        });
    }
    const rows = await this.records(target, target.chunk);
    const recordIds = [...rows.keys()];
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const viewId = `v${Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
    if (target.schema.views.some(view => view.id === viewId)) throw new WecomError('ID_COLLISION', '随机视图 ID 与已有视图重复，尚未提交。');
    const view = buildViewObject({ viewId, name: patch.name, type: patch.type || 'grid', actorUid: target.uid,
      recordIds, fields: normalizedFields, patch });
    const command = mutation(3006, { '1': sheetId, '2': view });
    return this.apply(target, [command], 'create_view', { view_id: viewId, name: patch.name }, async (_after, schema) => {
      const raw = schema.raw.k4.find((candidate: Raw) => candidate.k30 === viewId);
      return Boolean(raw && viewMatchesRaw(raw, view));
    });
  }

  async updateView(url: string, sheetId: string, revision: number, viewId: string, patch: ViewWriteInput, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const raw = target.schema.raw.k4.find((candidate: Raw) => candidate.k30 === viewId);
    if (!raw) throw new WecomError('UNKNOWN_VIEW', 'view_id 不存在或不可读取。', { view_id: viewId });
    // 用规范化配置摘要而不是原始视图对象：原始宽度映射会随分块读取范围变化。
    const actualViewDigest = normalizeView(raw, normalizeFields(target.schema, [sheetId])).config_digest;
    if (patch.expected_view_digest && actualViewDigest !== patch.expected_view_digest) {
      throw new WecomError('STALE_VIEW', '视图配置已变化；请重新读取视图后再决定修改。', { view_id: viewId,
        expected_view_digest: patch.expected_view_digest, actual_view_digest: actualViewDigest });
    }
    if (patch.type !== undefined && VIEW_TYPE_CODES[patch.type] !== raw.k32) {
      throw new WecomError('UNSUPPORTED_VIEW_CHANGE', '不支持修改视图类型；请新建目标类型视图。');
    }
    if (patch.kanban && raw.k32 !== 2) throw new WecomError('UNSUPPORTED_VIEW_CHANGE', '看板配置只能用于看板视图。');
    if (patch.kanban && patch.group !== undefined) throw new WecomError('INVALID_ARGUMENT', '看板分组请使用 kanban.group_field_id，不要同时传 group。');
    const normalizedFields = normalizeFields(target.schema, [target.sheetId]);
    const fieldsById = new Map(normalizedFields.map(field => [field.id, field]));
    const filterPatch = patch.filter;
    const properties = rawViewProperties(raw);
    const beforeWidths = rawWidths(raw);
    const changes: { commands: Mutation[]; verify: (schema: Schema) => boolean }[] = [];
    const currentView = (schema: Schema) => schema.raw.k4.find((candidate: Raw) => candidate.k30 === viewId);
    if (patch.scope !== undefined) {
      const level = patch.scope === 'personal' ? 3 : patch.scope === 'locked' ? 2 : 1;
      if (raw.k35 !== level) {
        // 个人/锁定/公共视图级别存于视图 k35；公共化时界面同时重写一次视图名称。
        const commands = level === 1
          ? [mutation(3009, { '1': sheetId, '2': viewId, '3': { '2': 1 } }),
            mutation(3009, { '1': sheetId, '2': viewId, '3': { '1': raw.k31 } })]
          : [mutation(3009, { '1': sheetId, '2': viewId, '3': { '2': level } })];
        changes.push({ commands, verify: schema => currentView(schema)?.k35 === level });
      }
    }
    if (patch.name !== undefined && patch.name !== raw.k31) {
      changes.push({ commands: [mutation(3009, { '1': sheetId, '2': viewId, '3': { '1': patch.name } })],
        verify: schema => currentView(schema)?.k31 === patch.name });
    }
    if (filterPatch !== undefined) {
      const filter = filterPatch === null ? { '1': 0, '2': [] } : encodeViewFilter(filterPatch, normalizedFields);
      changes.push({ commands: [mutation(3021, { '1': sheetId, '2': viewId, '3': filter })],
        verify: schema => {
          const actual = currentView(schema);
          if (!actual) return false;
          const expected = filterPatch === null ? null : encodeViewFilter(filterPatch, normalizedFields);
          return sameJson(rawFilterSummary(rawViewProperties(actual).k8), rawFilterSummary(expected));
        } });
    }
    const groupItems = patch.kanban?.group_field_id
      ? [{ field_id: patch.kanban.group_field_id, descending: false }]
      : patch.group;
    if (groupItems !== undefined) {
      const expected = encodeViewGroup(groupItems);
      changes.push({ commands: [mutation(3022, { '1': sheetId, '2': viewId, '3': { '1': true, '2': expected } })],
        verify: schema => {
          const actual = currentView(schema);
          return Boolean(actual && sameJson(placementSummary(rawViewProperties(actual).k7), placementSummary(expected)));
        } });
    }
    if (patch.sort !== undefined) {
      const expected = encodeViewSort(patch.sort);
      changes.push({ commands: [mutation(3020, { '1': sheetId, '2': viewId, '3': { '1': expected } })],
        verify: schema => {
          const actual = currentView(schema);
          return Boolean(actual && sameJson(placementSummary(rawViewProperties(actual).k9), placementSummary(expected)));
        } });
    }
    let hiddenPatch: string[] | undefined;
    if (patch.hidden_fields !== undefined && patch.kanban?.card_fields !== undefined) {
      throw new WecomError('INVALID_ARGUMENT', 'hidden_fields 与 kanban.card_fields 不能同时指定。');
    }
    if (patch.hidden_fields !== undefined) hiddenPatch = patch.hidden_fields;
    if (patch.kanban?.card_fields !== undefined) {
      const columns = rawColumnOrder(raw);
      const card = new Set(patch.kanban.card_fields);
      hiddenPatch = columns.filter(id => !card.has(id));
    }
    if (hiddenPatch !== undefined) {
      assertNoDuplicateFieldIds(hiddenPatch, '隐藏列');
      for (const id of hiddenPatch) if (!fieldsById.has(id)) throw new WecomError('UNKNOWN_FIELD', '隐藏列包含不存在字段。', { field_id: id });
      const desired = new Set(hiddenPatch);
      const current = new Set(rawHiddenFields(raw));
      const toHide = [...desired].filter(id => !current.has(id));
      const toShow = [...current].filter(id => !desired.has(id));
      const commands: Mutation[] = [];
      if (toHide.length) commands.push(mutation(3018, { '1': sheetId, '2': viewId, '3': toHide, '4': { '1': true } }));
      if (toShow.length) commands.push(mutation(3018, { '1': sheetId, '2': viewId, '3': toShow, '4': { '1': false } }));
      if (commands.length) changes.push({ commands, verify: schema => {
        const actual = currentView(schema);
        return Boolean(actual && compareHiddenFieldSets(rawHiddenFields(actual), [...desired]).length === 0);
      } });
    }
    if (patch.widths !== undefined) {
      const commands: Mutation[] = [];
      for (const [id, width] of Object.entries(patch.widths)) {
        if (!fieldsById.has(id)) throw new WecomError('UNKNOWN_FIELD', '列宽包含不存在字段。', { field_id: id });
        commands.push(mutation(3024, { '1': sheetId, '2': viewId, '3': id, '4': { '1': width } }));
      }
      const requested = Object.keys(patch.widths);
      if (commands.length) changes.push({ commands, verify: schema => {
        const actual = currentView(schema);
        if (!actual) return false;
        const afterWidths = rawWidths(actual);
        // 分别核查“请求已生效”和“未请求键未受损”；未请求键不能被局部写入重置。
        return compareRequestedWidths(afterWidths, patch.widths!).length === 0
          && compareProtectedWidths(beforeWidths, afterWidths, requested).length === 0;
      } });
    }
    if (patch.statistics !== undefined) {
      // 3025 写 k10（字段统计启用标志，不是底部统计行显隐）；null 归一化为关闭。
      const desired = encodeViewStatistics(patch.statistics)['1'];
      if (desired !== (properties.k10 === true)) {
        // 只核对 k10：同一次调用中的其他步骤会改变整体 config_digest，不能拿整视图摘要比较。
        changes.push({ commands: [mutation(3025, { '1': sheetId, '2': viewId, '3': encodeViewStatistics(desired) })],
          verify: schema => {
            const actual = currentView(schema);
            return Boolean(actual && viewStatisticsMatches(actual, desired));
          } });
      }
    }
    if (patch.frozen_field_count !== undefined) {
      const count = patch.frozen_field_count ?? 0;
      changes.push({ commands: [mutation(3033, { '1': sheetId, '2': viewId, '3': { '1': count } })],
        verify: schema => {
          const actual = currentView(schema);
          return Boolean(actual && rawViewProperties(actual).k4 === count);
        } });
    }
    if (patch.field_order !== undefined) {
      const currentOrder = rawColumnOrder(raw);
      // 与计划、核验共用同一契约：只允许重排当前视图全部列，不能增删或用全表字段补齐。
      const desiredOrder = validateUpdateFieldOrder(patch.field_order, {
        current_columns: currentOrder,
        table_field_ids: [...fieldsById.keys()],
        view_id: viewId,
      });
      // 顺序已符合要求时下面的循环不生成 3016 写入，版本不前进。
      let working = [...currentOrder];
      for (let index = 0; index < desiredOrder.length; index += 1) {
        const desiredId = desiredOrder[index];
        if (working[index] === desiredId) continue;
        const source = working.indexOf(desiredId);
        if (source < 0) throw new WecomError('INVALID_ARGUMENT', '列顺序包含不在视图中的字段。', { field_id: desiredId });
        const desired = [...working];
        desired.splice(source, 1);
        desired.splice(index, 0, desiredId);
        changes.push({ commands: [mutation(3016, { '1': sheetId, '2': viewId, '3': desiredId, '4': { '1': source, '2': index } })],
          verify: schema => {
            const actual = currentView(schema);
            return Boolean(actual && JSON.stringify(rawColumnOrder(actual)) === JSON.stringify(desired));
          } });
        working = desired;
      }
    }
    if (!changes.length) {
      return { status: 'verified', operation: 'update_view', previous_revision: target.chunk.revision,
        revision: target.chunk.revision, no_changes: true, view_id: viewId };
    }
    let current = target;
    let committedRevision = target.chunk.revision;
    const completed: Raw[] = [];
    for (let step = 0; step < changes.length; step += 1) {
      const change = changes[step];
      try {
        const result = await this.apply(current, change.commands, 'update_view', { view_id: viewId, step },
          async (_after, schema) => change.verify(schema));
        completed.push({ step, revision: result.revision, execution_id: result.execution_id });
        committedRevision = result.revision;
      } catch (error) {
        if (!completed.length) throw error;
        throw new WecomError('PARTIAL_APPLY', '视图更新分多步提交，部分步骤已生效；请先回读视图再决定是否继续。', {
          view_id: viewId, completed_steps: completed, failed_step: step, total_steps: changes.length,
          reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
          reason_message: error instanceof Error ? error.message : String(error),
          may_have_written: true, automatic_retry: false });
      }
      if (step !== changes.length - 1) {
        const chunk = await this.client.chunk(target.doc.id, target.sheetId, 0, 200);
        const schema = await this.client.schema(target.doc.id, chunk);
        current = { ...target, chunk, schema };
      }
    }
    return { status: 'verified', operation: 'update_view', previous_revision: target.chunk.revision,
      revision: committedRevision, no_changes: false, view_id: viewId };
  }

  async deleteView(url: string, sheetId: string, revision: number, viewId: string, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const index = target.schema.raw.k4.findIndex((candidate: Raw) => candidate.k30 === viewId);
    if (index < 0) throw new WecomError('UNKNOWN_VIEW', 'view_id 不存在或不可读取。', { view_id: viewId });
    return this.apply(target, [mutation(3007, { '1': sheetId, '2': viewId, '3': { '1': index } })],
      'delete_view', { view_id: viewId }, async (_after, schema) => !schema.raw.k4.some((candidate: Raw) => candidate.k30 === viewId));
  }

  private async commitBlock(url: string, target: Target, subId: string, command: Mutation, operation: string, affected: Raw,
    verify: (structure: Awaited<ReturnType<WecomClient['structure']>>) => boolean) {
    const revision = target.chunk.revision;
    const intent = { document_id: target.doc.id, sheet_id: target.sheetId, operation, ...affected,
      ...(target.planId ? { plan_id: target.planId } : {}) };
    const taskId = randomInt(1, 2 ** 48 - 1);
    const payload = {
      common: { need_optimize: true, once_mode: true, type: 'USER_CHANGES', curRev: revision, offlineMsg: true,
        docid: target.doc.id, uid: target.uid, dver: target.dver, base_rev: revision, code_ver: 0, session_type: 0,
        gray: 0, pver: target.pver, uuId: randomUUID() },
      respective: [{ task_id: taskId, subId, oSubId: false, head: false, keydata: false,
        changeSetCount: 1, changeset: JSON.stringify([[command]]) + '\n', changesetType: 'smartsheet' }],
    };
    const response = await this.post('/dop-api/commitchanges', { padId: target.doc.id, xsrf: this.client.cookie('TOK') },
      { data: JSON.stringify(payload) }, intent);
    let committedRevision: number | undefined;
    try {
      const matches = response.Data?.respective?.filter((entry: Raw) => entry.commitId === taskId);
      requireData(Array.isArray(matches) && matches.length === 1, '写入响应缺少当前请求的唯一确认。');
      const accepted = matches[0];
      requireData(accepted.revert === false && accepted.need === false && Number.isSafeInteger(accepted.newRev)
        && accepted.newRev === revision + 1, '写入确认的状态或版本无效。');
      committedRevision = accepted.newRev;
      const structure = await this.client.structure(url);
      if (!verify(structure)) throw new WecomError('WRITE_MISMATCH', '重新读取的结果与请求不一致。');
      const executionId = await this.recordExecution({ status: 'verified', document_id: target.doc.id,
        ...(target.planId ? { plan_id: target.planId } : {}),
        sheet_id: target.sheetId, operation, ...affected, previous_revision: revision,
        committed_revision: committedRevision, revision: committedRevision });
      return { ...intent, execution_id: executionId, status: 'verified', previous_revision: revision,
        committed_revision: committedRevision, revision: committedRevision };
    } catch (error) {
      const reasonCode = error instanceof WecomError ? error.code : 'LOCAL_ERROR';
      const reasonMessage = error instanceof WecomError ? error.message : '本地错误';
      const executionId = await this.recordExecution({ status: 'not_verified', document_id: target.doc.id,
        ...(target.planId ? { plan_id: target.planId } : {}),
        sheet_id: target.sheetId, operation, ...affected, committed_revision: committedRevision,
        reason_code: reasonCode, reason_message: reasonMessage });
      throw new WecomError('WRITE_NOT_VERIFIED', '服务端已返回写入响应，但回读未能完整核对；请先检查目标，不能直接重复提交。', {
        ...intent, execution_id: executionId, committed_revision: committedRevision, reason_code: reasonCode,
        reason_message: reasonMessage, may_have_written: true, automatic_retry: false,
      });
    }
  }

  async createSheet(url: string, title: string, revision: number, planId?: string) {
    const structure = await this.client.structure(url);
    if (structure.sheets.length === 0) throw new WecomError('UNKNOWN_SHEET', '文档中没有可定位的现有子表。');
    const target = await this.prepare(url, structure.sheets[0].id, revision, planId);
    const sheetId = newId('q');
    if (structure.sheets.some(sheet => sheet.id === sheetId)) throw new WecomError('ID_COLLISION', '随机子表 ID 与已有子表重复，尚未提交。');
    return this.commitBlock(url, target, sheetId, mutation(3001, { '1': sheetId, '2': title, '3': structure.sheets.length, '4': 0, '6': null }),
      'create_sheet', { sheet_id: sheetId, title }, result => result.sheets.some(sheet => sheet.id === sheetId && sheet.name === title));
  }

  async renameSheet(url: string, sheetId: string, revision: number, title: string, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    return this.commitBlock(url, target, sheetId, mutation(3004, { '1': sheetId, '2': { '1': title } }),
      'rename_sheet', { sheet_id: sheetId, title }, result => result.sheets.some(sheet => sheet.id === sheetId && sheet.name === title));
  }

  async deleteSheet(url: string, sheetId: string, revision: number, planId?: string) {
    const structure = await this.client.structure(url);
    if (structure.sheets.length <= 1) throw new WecomError('INVALID_ARGUMENT', '至少保留一个子表，不能删除最后一个。');
    const index = structure.sheets.findIndex(sheet => sheet.id === sheetId);
    if (index < 0) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此文档。', { sheet_id: sheetId });
    const parentId = structure.sheets[index].parent_id;
    const target = await this.prepare(url, sheetId, revision, planId);
    return this.commitBlock(url, target, sheetId, mutation(3002, { '1': sheetId, '2': index, '3': parentId ?? null }),
      'delete_sheet', { sheet_id: sheetId }, result => !result.sheets.some(sheet => sheet.id === sheetId));
  }

  async updateFields(url: string, sheetId: string, revision: number, fieldId: string,
    patch: { name?: string; user_multiple?: boolean; user_notify?: boolean }, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const raw = target.schema.raw.k3[fieldId];
    if (!raw) throw new WecomError('UNKNOWN_FIELD', '字段 ID 不存在或不可读取。', { field_id: fieldId });
    const changesUser = patch.user_multiple !== undefined || patch.user_notify !== undefined;
    if (changesUser && raw.k31 !== 7) throw new WecomError('INVALID_ARGUMENT', '只有人员字段可以修改多选与添加通知属性。', { field_id: fieldId });
    const config: Raw = {};
    if (patch.name !== undefined) config['30'] = patch.name;
    let expectedFlags: { '1': boolean; '2': boolean } | null = null;
    if (changesUser) {
      const current = raw.k7 || {};
      expectedFlags = { '1': patch.user_multiple ?? Boolean(current.k1), '2': patch.user_notify ?? Boolean(current.k2) };
      config['7'] = expectedFlags;
      config['31'] = 7;
    }
    const semanticGroups = ['number', 'date', 'select', 'text', 'url', 'progress', 'checkbox'] as const;
    const selectedGroups = semanticGroups.filter(group => (patch as Raw)[group] !== undefined);
    if (selectedGroups.length > 1) throw new WecomError('INVALID_ARGUMENT', '一次只能修改一类字段类型属性。', { groups: selectedGroups });
    let semanticPatch = false;
    if (selectedGroups.length === 1) {
      const type = raw.k31;
      const delta = buildSemanticFieldDelta(type, raw[`k${type}`], patch as Raw);
      config[String(type)] = delta;
      config['31'] = type;
      semanticPatch = true;
    }
    if (!Object.keys(config).length) {
      return { status: 'verified', operation: 'update_fields', previous_revision: target.chunk.revision,
        revision: target.chunk.revision, no_changes: true, field_id: fieldId };
    }
    return this.apply(target, [mutation(3017, { '1': sheetId, '3': fieldId, '4': config })], 'update_fields',
      { field_id: fieldId }, async (_after, schema) => {
        const actual = schema.raw.k3[fieldId];
        if (!actual) return false;
        if (patch.name !== undefined && actual.k30 !== patch.name) return false;
        if (expectedFlags && (actual.k7?.k1 !== expectedFlags['1'] || actual.k7?.k2 !== expectedFlags['2'])) return false;
        if (semanticPatch && !semanticFieldConfigMatches(actual.k31, actual[`k${actual.k31}`], patch as Raw)) return false;
        return true;
      });
  }

  async createLookupField(url: string, sheetId: string, revision: number, name: string,
    spec: { target_sheet_id?: string; target_field_id: string; relation_field_id?: string;
      aggregation: LookupSpec['aggregation']; fail_on_ambiguous?: boolean;
      conditions: { target_field_id: string; local_field_id?: string; value?: string | number | boolean | string[];
        operator?: 'eq' | 'contains' }[] }, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const relationField = spec.relation_field_id
      ? target.schema.fields.find(field => field.id === spec.relation_field_id) : undefined;
    if (spec.relation_field_id && !relationField) {
      throw new WecomError('UNKNOWN_FIELD', '沿关联字段引用需要来源表中存在的关联字段。', { field_id: spec.relation_field_id });
    }
    if (relationField && ![18, 21].includes(relationField.type_code)) {
      throw new WecomError('INVALID_ARGUMENT', '沿关联字段引用只能使用单向或双向关联字段。', { field_id: relationField.id });
    }
    let targetSheetId = spec.target_sheet_id;
    if (relationField) {
      const relationReadback = target.schema.raw.k3[relationField.id];
      const relationTarget = relationReadback?.[`k${relationField.type_code}`]?.k2;
      if (typeof relationTarget !== 'string' || !relationTarget) {
        throw new WecomError('UNSUPPORTED_FIELD_CONFIG', '关联字段缺少可读取的目标子表。', { field_id: relationField.id });
      }
      if (targetSheetId && targetSheetId !== relationTarget) {
        throw new WecomError('INVALID_ARGUMENT', '目标子表与关联字段指向的子表不一致。', { target_sheet_id: targetSheetId, relation_target: relationTarget });
      }
      targetSheetId = relationTarget;
      if (spec.conditions.length) throw new WecomError('INVALID_ARGUMENT', '沿关联字段引用不能同时提供条件匹配。');
    } else {
      if (!targetSheetId) throw new WecomError('INVALID_ARGUMENT', '条件匹配模式需要 target_sheet_id。');
      if (!spec.conditions.length) throw new WecomError('INVALID_ARGUMENT', '条件匹配模式至少需要一个条件。');
    }
    const targetChunk = await this.client.chunk(target.doc.id, targetSheetId, 0, 1);
    const targetSchema = await this.client.schema(target.doc.id, targetChunk);
    const targetField = targetSchema.fields.find(field => field.id === spec.target_field_id);
    if (!targetField) throw new WecomError('UNKNOWN_FIELD', '要引用的目标字段不存在或不可读取。', { target_sheet_id: targetSheetId, target_field_id: spec.target_field_id });
    if (['sum', 'average', 'max', 'min'].includes(spec.aggregation) && ![2, 14].includes(targetField.type_code)) {
      throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '求和/平均/最大/最小只能用于数字或进度字段。', { field_type: targetField.type_code });
    }
    const resolvedConditions = spec.conditions.map((condition, index) => {
      const targetFieldForCondition = targetSchema.fields.find(field => field.id === condition.target_field_id);
      if (!targetFieldForCondition) {
        throw new WecomError('UNKNOWN_FIELD', '查找条件引用了目标表中不存在的字段。', { field_id: condition.target_field_id, index });
      }
      if (condition.local_field_id !== undefined && condition.value !== undefined) {
        throw new WecomError('INVALID_ARGUMENT', '查找条件不能同时使用本表字段和固定值。', { index });
      }
      if (condition.local_field_id === undefined && condition.value === undefined) {
        throw new WecomError('INVALID_ARGUMENT', '查找条件必须提供本表字段或固定值。', { index });
      }
      if (condition.local_field_id !== undefined && !target.schema.fields.some(field => field.id === condition.local_field_id)) {
        throw new WecomError('UNKNOWN_FIELD', '查找条件引用了本表中不存在的字段。', { field_id: condition.local_field_id });
      }
      let value = condition.value;
      if (value !== undefined) {
        const type = targetFieldForCondition.type_code;
        if (type === 1) {
          if (typeof value !== 'string') throw new WecomError('INVALID_ARGUMENT', '文本建议值必须是字符串。', { index });
        } else if (type === 17 || type === 9) {
          const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
          if (!ids || ids.some(id => typeof id !== 'string' || !targetFieldForCondition.options?.some(option => option.id === id))) {
            throw new WecomError('UNKNOWN_OPTION', '单选/多选建议值必须是目标字段的已有选项 ID。', { field_id: targetFieldForCondition.id, index });
          }
          value = type === 17 ? [ids[0]] : ids;
        } else if (type === 2) {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new WecomError('INVALID_ARGUMENT', '数字建议值必须是有限数字。', { index });
        } else if (type === 4) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new WecomError('INVALID_ARGUMENT', '日期建议值必须是毫秒时间戳。', { index });
          value = String(value);
        } else {
          throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '此字段类型的固定值条件尚未验证。', { field_type: type, index });
        }
      }
      return {
        target_field_id: condition.target_field_id,
        target_field_type: targetFieldForCondition.type_code,
        operator_code: condition.operator === 'contains' ? 3 : 1,
        ...(condition.local_field_id !== undefined ? { local_field_id: condition.local_field_id } : { value }),
      };
    });
    const resolvedSpec: LookupSpec = { target_sheet_id: targetSheetId, target_field_id: spec.target_field_id,
      aggregation: spec.aggregation, conditions: resolvedConditions,
      ...(spec.relation_field_id ? { relation_field_id: spec.relation_field_id } : {}) };
    const diagnostics = await this.lookupDiagnostics(target, sheetId, targetSheetId, targetSchema,
      resolvedConditions, spec.relation_field_id, spec.fail_on_ambiguous === true);
    const { field, expected, mutations } = lookupFieldMutations(sheetId, target.schema, name, resolvedSpec);
    const result = await this.apply(target, mutations, 'create_lookup_field',
      { field_id: field.id, name, target_sheet_id: targetSheetId,
        ...(spec.relation_field_id ? { relation_field_id: spec.relation_field_id } : {}) },
      async (_after, schema) => {
        const raw = schema.raw.k3[field.id];
        if (!raw || raw.k30 !== name || raw.k31 !== 20) return false;
        const config = raw.k20 || {};
        const conditions = config.k6?.k2 || [];
        if (spec.relation_field_id) {
          return config.k1 === spec.relation_field_id && config.k2 === spec.target_field_id
            && config.k3 === expected['20']['3'] && config.k4 === 0 && config.k5 === '' && conditions.length === 0;
        }
        return config.k1 === '' && config.k2 === spec.target_field_id && config.k5 === targetSheetId
          && config.k4 === 1 && config.k3 === expected['20']['3']
          && conditions.length === resolvedConditions.length
          && resolvedConditions.every((condition, index) => {
            const localFieldId = 'local_field_id' in condition ? condition.local_field_id : undefined;
            return conditions[index]?.k2 === condition.target_field_id
              && (localFieldId !== undefined ? conditions[index]?.k5?.k2 === localFieldId : conditions[index]?.k5?.k1 === 0);
          });
      });
    return { ...result, diagnostics };
  }

  private async lookupDiagnostics(target: Target, sourceSheetId: string, targetSheetId: string,
    targetSchema: Schema, conditions: LookupSpec['conditions'], relationFieldId: string | undefined,
    failOnAmbiguous: boolean) {
    const sourceRows = await this.allRows(target, sourceSheetId);
    const targetRows = await this.allRows(target, targetSheetId);
    if (relationFieldId) {
      const relation = target.schema.fields.find(field => field.id === relationFieldId);
      const type = relation?.type_code;
      let linked = 0; let empty = 0; let links = 0;
      for (const row of sourceRows) {
        const cell = row.raw.k1?.[relationFieldId];
        const ids = type === 21
          ? (cell?.k21?.k1 || []).map((item: Raw) => item.k3).filter((id: unknown) => typeof id === 'string')
          : (cell?.[`k${type}`] || []).filter((id: unknown) => typeof id === 'string');
        links += ids.length;
        if (ids.length) linked += 1; else empty += 1;
      }
      return { mode: 'relation', relation_field_id: relationFieldId, source_records: sourceRows.length,
        target_records: targetRows.length, linked_source_records: linked, empty_source_records: empty, links,
        ambiguous: false };
    }
    const keyCondition = conditions.find(condition => condition.local_field_id !== undefined);
    if (!keyCondition) {
      return { mode: 'conditions', key_field: null, source_records: sourceRows.length,
        target_records: targetRows.length, ambiguous: false, zero_match_source_records: null, multi_match_source_records: null };
    }
    const targetKeyField = targetSchema.fields.find(field => field.id === keyCondition.target_field_id);
    const sourceKeyField = target.schema.fields.find(field => field.id === keyCondition.local_field_id);
    requireData(targetKeyField && sourceKeyField, '查找诊断缺少匹配键字段。');
    const targetCounts = new Map<string, number>();
    for (const row of targetRows) {
      const key = derivedCellKey(row.raw.k1?.[targetKeyField.id], targetKeyField.type_code);
      if (key !== null) targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
    }
    let zero = 0; let multi = 0; let empty = 0; const sourceCounts = new Map<string, number>();
    for (const row of sourceRows) {
      const key = derivedCellKey(row.raw.k1?.[sourceKeyField.id], sourceKeyField.type_code);
      if (key === null) { empty += 1; continue; }
      sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
      const count = targetCounts.get(key) || 0;
      if (count === 0) zero += 1;
      if (count > 1) multi += 1;
    }
    const duplicateKeys = [...targetCounts.entries()].filter(([, count]) => count > 1)
      .slice(0, 20).map(([value, count]) => ({ value, count }));
    if (failOnAmbiguous && duplicateKeys.length) {
      throw new WecomError('LOOKUP_AMBIGUOUS', '目标表匹配键存在多匹配；请先明确聚合规则或修正匹配键。', {
        key_field_id: targetKeyField.id, duplicate_keys: duplicateKeys });
    }
    return { mode: 'conditions', key_field: targetKeyField.id, source_key_field: sourceKeyField.id,
      source_records: sourceRows.length, target_records: targetRows.length,
      distinct_target_keys: targetCounts.size, distinct_source_keys: sourceCounts.size,
      duplicate_keys: duplicateKeys, zero_match_source_records: zero, multi_match_source_records: multi,
      empty_source_keys: empty, ambiguous: duplicateKeys.length > 0 };
  }

  async createRelationField(url: string, sheetId: string, revision: number, name: string, spec: RelationSpec, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    await this.client.chunk(target.doc.id, spec.target_sheet_id, 0, 1);
    const { field, mutations } = relationFieldMutations(target.doc.id, sheetId, target.schema, name, spec);
    const twoWay = spec.two_way === true;
    return this.apply(target, mutations, 'create_relation_field', { field_id: field.id, name, target_sheet_id: spec.target_sheet_id,
      ...(twoWay ? { two_way: true, back_field_id: (field as { back_field_id?: string }).back_field_id } : {}) },
      async (_after, schema) => {
        const raw = schema.raw.k3[field.id];
        if (!raw || raw.k30 !== name || raw.k31 !== field.type_code) return false;
        // 同文档关联时服务端会省略 k1（文档 ID）；以目标子表和多选标志为准。
        const property = raw[`k${field.type_code}`];
        if (property?.k2 !== spec.target_sheet_id || property?.k4 !== spec.multiple) return false;
        if (!twoWay) return true;
        const backFieldId = property?.k6;
        if (typeof backFieldId !== 'string' || !backFieldId) return false;
        const reverseChunk = await this.client.chunk(target.doc.id, spec.target_sheet_id, 0, 1);
        if (!reverseChunk.schema) return false;
        const reverse = reverseChunk.schema.raw.k3[backFieldId];
        // 反向字段由服务端在同一提交内自动创建，必须是类型 21 且指回正向字段与本表。
        return Boolean(reverse && reverse.k31 === 21 && reverse.k21?.k2 === sheetId && reverse.k21?.k6 === field.id);
      });
  }

  async uploadAsset(url: string, sheetId: string, revision: number, fieldId: string, recordId: string,
    filePath: string, viewId?: string, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const field = target.schema.fields.find(candidate => candidate.id === fieldId);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '字段 ID 不存在或不可读取。', { field_id: fieldId });
    if (![5, 6].includes(field.type_code)) throw new WecomError('INVALID_ARGUMENT', '只有图片或附件字段可以上传文件。', { field_id: fieldId });
    await this.requireRecords(target, [recordId]);
    const buffer = await readFile(filePath);
    if (!buffer.length) throw new WecomError('INVALID_ARGUMENT', '文件为空，未上传。', { file_path: filePath });
    if (buffer.length > 50 * 1024 * 1024) throw new WecomError('INVALID_ARGUMENT', '文件超过 50 MiB，未上传。', { size: buffer.length });
    const fileName = basename(filePath);
    const ext = extname(fileName).replace(/^\./, '').toLowerCase() || 'bin';
    const md5 = createHash('md5').update(buffer).digest('hex');
    const views = target.schema.raw.k4.filter((candidate: Raw) => {
      const columns = candidate[`k${candidate.k32}`]?.k2;
      return Array.isArray(columns) && columns.includes(fieldId);
    });
    const effectiveView = viewId || views[0]?.k30 || target.schema.raw.k4[0]?.k30;
    if (!effectiveView) throw new WecomError('UNKNOWN_VIEW', '没有可用于上传定位的视图。');
    const type = field.type_code;
    let entry: Raw;
    let verifyAsset: (cell: Raw) => boolean;
    if (type === 5) {
      const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
      const imageUrl = new URL('/diskthumb/doc_img_upload', 'https://doc.weixin.qq.com');
      imageUrl.searchParams.set('globalPadId', target.doc.id);
      imageUrl.searchParams.set('sid', this.client.cookie('wedoc_sid'));
      imageUrl.searchParams.set('wedoc_xsrf', this.client.cookie('low_login_enable'));
      const uploadResponse = await this.client.context.post(imageUrl.href, {
        multipart: { file: { name: fileName, mimeType: mimeTypes[ext] || 'application/octet-stream', buffer } },
        headers: { Referer: 'https://doc.weixin.qq.com/', Accept: 'application/json, text/plain, */*' }, maxRedirects: 0, maxRetries: 0,
      });
      let uploadBody: Raw;
      try {
        if (!uploadResponse.ok()) throw new WecomError('UPLOAD_FAILED', '图片上传接口返回 HTTP 错误。', { http_status: uploadResponse.status() });
        uploadBody = await uploadResponse.json();
      } finally { await uploadResponse.dispose(); }
      const info = uploadBody?.body;
      if (uploadBody?.head?.ret !== 0 || info?.retcode !== 0 || typeof info?.url !== 'string'
        || !Number.isFinite(info.width) || !Number.isFinite(info.height)) {
        throw new WecomError('UPLOAD_FAILED', '图片上传响应缺少 URL 或尺寸。', { retcode: uploadBody?.head?.ret, message: uploadBody?.head?.msg });
      }
      const imageId = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      entry = { '1': imageId, '2': fileName, '3': info.url, '4': info.width, '5': info.height };
      verifyAsset = cell => cell.k1 === imageId && cell.k3 === info.url;
    } else {
      const form = {
        father_id: 'doc', name: fileName, size: String(buffer.length), file_base64_content: buffer.toString('base64'),
        doc_id: target.doc.id, ss_share_code: '', ss_sub_id: sheetId, ss_view_id: effectiveView,
        from: 'smartsheet', ss_field_id: fieldId, ss_record_id: recordId,
      };
      const uploadUrl = new URL('/diskagent/upload', 'https://doc.weixin.qq.com');
      uploadUrl.searchParams.set('sid', this.client.cookie('wedoc_sid'));
      uploadUrl.searchParams.set('wedoc_xsrf', this.client.cookie('low_login_enable'));
      uploadUrl.searchParams.set('xsrf', this.client.cookie('TOK'));
      const uploadResponse = await this.client.context.post(uploadUrl.href, {
        form, headers: { Referer: 'https://doc.weixin.qq.com/', Accept: 'application/json, text/plain, */*' }, maxRedirects: 0, maxRetries: 0,
      });
      let uploadBody: Raw;
      try {
        if (!uploadResponse.ok()) throw new WecomError('UPLOAD_FAILED', '文件上传接口返回 HTTP 错误。', { http_status: uploadResponse.status() });
        uploadBody = await uploadResponse.json();
      } finally { await uploadResponse.dispose(); }
      const fileId = uploadBody?.body?.file_info?.file_id;
      if (uploadBody?.head?.ret !== 0 || typeof fileId !== 'string' || !fileId.startsWith('*ss*')) {
        throw new WecomError('UPLOAD_FAILED', '文件上传响应缺少可用的文件标识。', { retcode: uploadBody?.head?.ret, message: uploadBody?.head?.msg });
      }
      entry = { '1': fileName, '2': buffer.length, '3': ext, '4': md5, '6': fileId, '7': 'SS_File', '8': 2 };
      verifyAsset = cell => cell.k1 === fileName && cell.k2 === buffer.length && cell.k4 === md5;
    }
    const delta = { '30': type, [String(type)]: [entry], '31': target.uid };
    try {
      return await this.apply(target, [mutation(3013, { '1': sheetId, '3': recordId, '4': { [fieldId]: delta }, '5': target.user, '7': false })],
        'upload_asset', { field_id: fieldId, record_id: recordId, name: fileName, size: buffer.length },
        async (after) => {
          const row = after.records.find(record => record.id === recordId);
          const cells = row?.raw?.k1?.[fieldId]?.[`k${type}`];
          return Array.isArray(cells) && cells.some((cell: Raw) => verifyAsset(cell));
        });
    } catch (error) {
      throw new WecomError('PARTIAL_APPLY', '文件已上传，但单元格写入未确认；请先回读目标单元格，不要重复上传。', {
        field_id: fieldId, record_id: recordId, file_name: fileName, size: buffer.length,
        uploaded_asset_id: type === 5 ? entry['1'] : entry['6'],
        reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        reason_message: error instanceof Error ? error.message : String(error),
        may_have_written: true, automatic_retry: false });
    }
  }

  async updateRelationCells(url: string, sheetId: string, revision: number, fieldId: string,
    updates: { record_id: string; target_record_ids: string[] }[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const raw = target.schema.raw.k3[fieldId];
    if (!raw || (raw.k31 !== 18 && raw.k31 !== 21)) {
      throw new WecomError('INVALID_ARGUMENT', '只有关联字段可以写入关联单元格。', { field_id: fieldId });
    }
    const twoWay = raw.k31 === 21;
    const targetSheetId = raw[`k${raw.k31}`]?.k2;
    if (typeof targetSheetId !== 'string') throw new WecomError('UNSUPPORTED_FIELD_CONFIG', '关联字段缺少可读取的目标子表。', { field_id: fieldId });
    const backFieldId = twoWay ? raw.k21?.k6 : undefined;
    if (twoWay && typeof backFieldId !== 'string') {
      throw new WecomError('UNSUPPORTED_FIELD_CONFIG', '双向关联缺少可读取的反向字段。', { field_id: fieldId });
    }
    uniqueIds(updates.map(update => update.record_id), '记录列表');
    const existingRows = await this.requireRecords(target, updates.map(update => update.record_id));
    const targetRecords = new Map<string, { id: string; raw: Raw }>();
    let page = await this.client.chunk(target.doc.id, targetSheetId, 0, 200);
    for (;;) {
      for (const record of page.records) targetRecords.set(record.id, record);
      const next = page.end + 1;
      if (next >= page.total) break;
      page = await this.client.chunk(target.doc.id, targetSheetId, next, 200);
    }
    for (const update of updates) {
      uniqueIds(update.target_record_ids, '关联目标记录');
      const missing = update.target_record_ids.filter(id => !targetRecords.has(id));
      if (missing.length) throw new WecomError('UNKNOWN_RECORD', '关联目标记录不存在或不可读取，尚未写入。', { record_ids: missing });
    }
    const currentIds = (cell: Raw | undefined) => new Set<string>(
      (cell?.k21?.k1 || []).map((item: Raw) => item.k3));
    const mutations: Mutation[] = [];
    for (const update of updates) {
      const row = existingRows.get(update.record_id);
      if (twoWay) {
        const current = [...currentIds(row?.raw.k1?.[fieldId])];
        const desired = update.target_record_ids;
        const adds = desired.filter(id => !current.includes(id))
          .map((id, offset) => ({ '1': 1, '2': current.length + offset, '3': id }));
        const removes = current.filter(id => !desired.includes(id))
          .map(id => ({ '1': 2, '2': current.indexOf(id), '3': id }));
        if (!adds.length && !removes.length) continue;
        mutations.push(mutation(3013, {
          '1': sheetId, '3': update.record_id,
          '4': { [fieldId]: { '30': 21, '21': { '1': adds, '2': removes }, '31': target.uid } },
          // 类型 21 必须显式请求跨表同步，服务端才会回填反向单元格。
          '5': target.user, '6': true, '7': false,
        }));
      } else {
        mutations.push(mutation(3013, {
          '1': sheetId, '3': update.record_id,
          '4': { [fieldId]: { '30': 18, '18': update.target_record_ids } },
          '5': target.user, '7': false,
        }));
      }
    }
    if (!mutations.length) {
      return { document_id: target.doc.id, sheet_id: sheetId, operation: 'update_relation_cells',
        field_id: fieldId, records: updates.length, status: 'verified', previous_revision: revision,
        committed_revision: revision, revision };
    }
    const wanted = new Map(updates.map(update => [update.record_id, new Set(update.target_record_ids)]));
    return this.apply(target, mutations, 'update_relation_cells', { field_id: fieldId, records: mutations.length },
      async (after) => {
        for (const [recordId, expected] of wanted) {
          const row = after.records.find(record => record.id === recordId);
          if (!row) return false;
          const cell = row.raw.k1?.[fieldId];
          const actual = twoWay
            ? new Set<string>((cell?.k21?.k1 || []).map((item: Raw) => item.k3))
            : new Set<string>(cell?.k18 || []);
          if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) return false;
          if (twoWay) {
            // 反向单元格必须同时出现本记录 ID，才算双向同步成立；必须回读提交后的目标表。
            const reverseRecords = new Map<string, { id: string; raw: Raw }>();
            let reversePage = await this.client.chunk(target.doc.id, targetSheetId, 0, 200);
            for (;;) {
              for (const record of reversePage.records) reverseRecords.set(record.id, record);
              const next = reversePage.end + 1;
              if (next >= reversePage.total) break;
              reversePage = await this.client.chunk(target.doc.id, targetSheetId, next, 200);
            }
            for (const id of expected) {
              const reverseCell = reverseRecords.get(id)?.raw.k1?.[backFieldId as string];
              const reverse = new Set<string>((reverseCell?.k21?.k1 || []).map((item: Raw) => item.k3));
              if (!reverse.has(recordId)) return false;
            }
          }
        }
        return true;
      });
  }

  async createFormulaField(url: string, sheetId: string, revision: number, name: string,
    formula: { expression: FormulaExpression; result_type: string; format?: FormulaFormatSpec | string; dependencies?: string[] }, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const normalized = normalizeFields(target.schema, [sheetId]);
    assertProviderFormulaSupport(formula.expression, normalized, 'write');
    assertFormulaDefinition(formula, normalized);
    const tokens = encodeProviderFormula(formula.expression, normalized);
    const formatter = resolveFormulaFormat(formula.format);
    const { field, mutations } = formulaFieldMutations(sheetId, target.schema, name, tokens, formatter);
    const result = await this.apply(target, mutations, 'create_formula_field', { field_id: field.id, name },
      async (_after, schema) => {
        const raw = schema.raw.k3[field.id];
        if (!raw || raw.k30 !== name || raw.k31 !== 19) return false;
        const actual = raw.k19?.k1;
        return Array.isArray(actual) && actual.length === tokens.length
          && tokens.every((token, index) => actual[index]?.k1 === token['1']
            && (actual[index]?.k2 || null) === (token['2'] || null)
            && (actual[index]?.k3 || null) === (token['3'] || null))
          && formulaFormatterMatches(raw.k19?.k2, formatter);
      });
    return { ...result, config_status: result.status === 'verified' ? 'saved' : 'unknown', calculation: await this.formulaCalculation(target, field.id) };
  }

  async updateFormulaField(url: string, sheetId: string, revision: number, fieldId: string,
    patch: { name?: string; formula?: { expression: FormulaExpression; result_type: string; format?: FormulaFormatSpec | string; dependencies?: string[] } }, planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const raw = target.schema.raw.k3[fieldId];
    if (!raw || raw.k31 !== 19) throw new WecomError('INVALID_ARGUMENT', '字段不是公式字段。', { field_id: fieldId });
    const config: Raw = {};
    if (patch.name !== undefined) config['30'] = patch.name;
    let tokens: any[] | null = null;
    let formatter: Raw | undefined;
    if (patch.formula) {
      const normalized = normalizeFields(target.schema, [sheetId]);
      assertProviderFormulaSupport(patch.formula.expression, normalized, 'write');
      assertFormulaDefinition(patch.formula, normalized, { field_id: fieldId });
      tokens = encodeProviderFormula(patch.formula.expression, normalized);
      formatter = resolveFormulaFormat(patch.formula.format) ?? raw.k19?.k2;
      config['19'] = { '1': tokens, ...(formatter ? { '2': formatter } : {}) };
      config['31'] = 19;
    }
    if (!Object.keys(config).length) {
      return { status: 'verified', operation: 'update_formula_field', previous_revision: target.chunk.revision,
        revision: target.chunk.revision, no_changes: true, field_id: fieldId };
    }
    const result = await this.apply(target, [mutation(3017, { '1': sheetId, '3': fieldId, '4': config })], 'update_formula_field',
      { field_id: fieldId }, async (_after, schema) => {
        const actual = schema.raw.k3[fieldId];
        if (!actual) return false;
        if (patch.name !== undefined && actual.k30 !== patch.name) return false;
        if (tokens) {
          const actualTokens = actual.k19?.k1;
          if (!Array.isArray(actualTokens) || actualTokens.length !== tokens.length) return false;
          if (!tokens.every((token, index) => actualTokens[index]?.k1 === token['1']
            && (actualTokens[index]?.k2 || null) === (token['2'] || null)
            && (actualTokens[index]?.k3 || null) === (token['3'] || null))) return false;
          if (formatter && !formulaFormatterMatches(actual.k19?.k2, formatter)) return false;
        }
        return true;
      });
    return { ...result, config_status: result.status === 'verified' ? 'saved' : 'unknown', calculation: await this.formulaCalculation(target, fieldId) };
  }

  private async formulaCalculation(target: Target, fieldId: string) {
    let rows: Raw[] = [];
    let counts = { computed: 0, empty: 0, pending: 0, errors: 0 };
    // 计算可能异步完成；有限次数等待，超时保持 pending，不把“未返回”当成空值。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const chunk = await this.client.chunk(target.doc.id, target.sheetId, 0, 50);
      rows = chunk.records.map(record => {
        const parsed = parseDerivedResult(record.raw.k1?.[fieldId]);
        const items = parsed?.computed_result?.data || [];
        const text = items.map((item: Raw) => item.text).filter((value: unknown): value is string => typeof value === 'string').join('');
        return { record_id: record.id, status: parsed?.status ?? 'missing', text,
          result_type: parsed?.result_type ?? null, error: (parsed as Raw)?.errors?.[0] ?? null };
      });
      counts = {
        computed: rows.filter(row => row.status === 'present').length,
        empty: rows.filter(row => row.status === 'empty').length,
        pending: rows.filter(row => ['pending', 'missing', 'unresolved', 'parse_error'].includes(row.status)).length,
        errors: rows.filter(row => row.status === 'error').length,
      };
      if (counts.errors || counts.computed || counts.empty) break;
      if (attempt < 3) await setTimeout(500, undefined, { signal: this.signal });
    }
    const status = counts.errors ? 'errors' : counts.computed ? 'computed' : counts.empty ? 'empty' : 'pending';
    const calculationStatus = counts.errors ? 'error' : counts.computed ? 'verified' : counts.empty ? 'empty' : 'pending';
    const resultType = rows.find(row => row.result_type)?.result_type ?? null;
    return {
      status, config_status: 'saved', calculation_status: calculationStatus,
      sampled: rows.length, computed: counts.computed, empty: counts.empty, pending: counts.pending, errors: counts.errors,
      result_type: resultType, samples: rows.slice(0, 5),
      ...(counts.errors ? { error_details: rows.filter(row => row.error).map(row => ({ record_id: row.record_id, ...row.error })) } : {}),
    };
  }

  async addFields(url: string, sheetId: string, revision: number, columns: ColumnInput[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const { fields, mutations } = addColumnMutations(sheetId, target.schema, columns);
    return this.apply(target, mutations, 'add_fields', { fields }, async (_after, schema) => columnViewsMatch(target.schema, schema, fields.map(f => f.id), []) && fields.every(field => {
      const actual = schema.fields.find(f => f.id === field.id);
      return actual?.name === field.name && actual.type_code === field.type_code && (!field.options ||
        (actual.options?.length === field.options.length && field.options.every(o => actual.options?.some(a => a.id === o.id && a.name === o.name))));
    }));
  }

  async deleteFields(url: string, sheetId: string, revision: number, ids: string[], planId?: string) {
    const target = await this.prepare(url, sheetId, revision, planId);
    const commands = deleteColumnMutations(sheetId, target.schema, ids);
    return this.apply(target, commands, 'delete_fields', { field_ids: ids }, async (_after, schema) => columnViewsMatch(target.schema, schema, [], ids) && ids.every(id => !schema.fields.some(f => f.id === id)));
  }

  async createTable(title: string) {
    this.cancelled();
    await this.client.checkSession();
    const response = await this.post('/webdisk/create', { sid: this.client.cookie('wedoc_sid'), wedoc_xsrf: this.client.cookie('low_login_enable') },
      { func: '16', name: title, space_id: '', father_id: '', add_to_open_list: 'true' }, { operation: 'create_table', title });
    let url: string | undefined;
    try {
      requireData(response.head?.ret === 0 && typeof response.body?.file_info?.doc_url === 'string', '新建响应缺少智能表格链接。');
      const doc = documentUrl(response.body.file_info.doc_url);
      url = new URL(`/smartsheet/${doc.id}`, DOC).href;
      const structure = await this.client.structure(url);
      requireData(structure.title === title && structure.sheets.length > 0, '新建智能表格的名称或子表未通过回读核对。');
      return { operation: 'create_table', status: 'verified', url, ...structure };
    } catch (error) {
      throw new WecomError('WRITE_NOT_VERIFIED', '新建请求已返回，但无法完整核对新表；请先检查已创建的表，避免重复新建。', {
        operation: 'create_table', title, ...(url ? { url } : {}), may_have_written: true, automatic_retry: false,
        reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        ...(error instanceof WecomError ? { reason_message: error.message } : {}),
      });
    }
  }

  private async documentRole(documentId: string) {
    const result = await this.client.desktopRead('/diskauth/get_auth_info', { func: '5', doc_ids: documentId, from: 'mydoc' });
    return parseDocumentRole(result, documentId);
  }

  private async inRecycleBin(fileId: string) {
    let cursor = '';
    const seen = new Set<string>();
    for (;;) {
      this.cancelled();
      const page = parseRecyclePage(await this.client.desktopRead('/diskfile/recycle_list', {
        func: '7', skip_file: 'false', sync_key: cursor, return_user_name: 'true', skip_album: 'true',
      }), fileId);
      if (page.found) return true;
      if (page.finished) return false;
      if (page.cursor === cursor || seen.has(page.cursor)) throw new WecomError('PARSE_ERROR', '回收站分页没有前进，无法核对删除结果。');
      seen.add(page.cursor);
      cursor = page.cursor;
    }
  }

  async deleteTable(reference: { url?: string; document_id?: string }, checkOnly = false) {
    this.cancelled();
    const doc = documentReference(reference);
    await this.client.checkSession();
    const role = await this.documentRole(doc.id);
    const fileId = role.fileId;
    const identity = { operation: 'delete_table', document_id: doc.id, url: new URL(`/smartsheet/${doc.id}`, DOC).href, file_id: fileId, title: role.title };
    if (await this.inRecycleBin(fileId)) return { ...identity, status: 'verified', state: 'recycle_bin', permanent: false,
      checked_only: checkOnly, already_in_recycle_bin: true, recycle_verified: true };
    const { open } = await this.client.openDocument(doc.url.href);
    if (checkOnly) return { ...identity, status: 'verified', state: 'active', checked_only: true, title: open.clientVars.title };
    // 网页操作权限 23 = 删除，25 = 永久删除；此处只使用 23 和 file_mgr 的移入回收站操作。
    if (!role.canDelete) throw new WecomError('DELETE_ACCESS_DENIED', '当前账号没有此智能表格文档的删除权限，尚未提交。', { document_id: doc.id });
    const response = await this.post('/webdisk/file_mgr', { sid: this.client.cookie('wedoc_sid'), wedoc_xsrf: this.client.cookie('low_login_enable') },
      { func: '4', selectAll: 'false', async: 'true', timestamp: String(Date.now()), doc_id: doc.id }, identity);
    let taskId: string | undefined;
    try {
      requireData(response.head?.ret === 0 && typeof response.body?.task_id === 'string' && response.body.task_id.length > 0, '删除响应缺少异步任务 ID。');
      taskId = response.body.task_id;
      const deadline = Date.now() + 30000;
      let finished = false;
      while (Date.now() < deadline) {
        this.cancelled();
        const task = await this.client.desktopRead('/diskfile/querytaskresult', { task_id: taskId! });
        if (task.finish === true) {
          if (task.err_code !== 0) throw new WecomError('DELETE_TASK_FAILED', '删除任务返回失败。');
          finished = true;
          break;
        }
        requireData(task.finish === undefined || task.finish === false, '删除任务完成状态的结构无效。');
        await setTimeout(200, undefined, { signal: this.signal });
      }
      if (!finished) throw new WecomError('DELETE_TASK_TIMEOUT', '删除任务在核对时限内尚未完成。');
      requireData(await this.inRecycleBin(fileId), '回收站未确认目标文件，不能只凭提交成功断言已删除。');
      return { ...identity, title: open.clientVars.title, status: 'verified', state: 'recycle_bin', permanent: false,
        checked_only: false, already_in_recycle_bin: false, recycle_verified: true, task_id: taskId };
    } catch (error) {
      throw new WecomError('WRITE_NOT_VERIFIED', '删除已提交，但未完整确认移入回收站；请使用 check_only: true 核对，不要重复提交删除。', {
        ...identity, ...(taskId ? { task_id: taskId } : {}), may_have_written: true, automatic_retry: false,
        reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        ...(error instanceof WecomError ? { reason_message: error.message } : {}),
        verification: { tool: 'wecom_delete_table', document_id: doc.id, check_only: true },
      });
    }
  }
}
