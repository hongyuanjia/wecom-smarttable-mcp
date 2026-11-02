import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { runningBuild } from './build-info.js';
import { requireData, WecomError } from './errors.js';
import { parseMemberCell } from './members.js';

// 将已实测网页协议的数字键解析集中在此；MCP 入口使用语义化参数。
type Raw = Record<string, any>;
export const fieldTypes: Record<number, string> = {
  1: 'TEXT', 2: 'NUMBER', 3: 'CHECKBOX', 4: 'DATE_TIME', 5: 'IMAGE', 6: 'ATTACHMENT',
  7: 'USER', 8: 'URL', 9: 'MULTIPLE_SELECT', 10: 'CREATED_USER', 11: 'MODIFIED_USER',
  12: 'CREATED_TIME', 13: 'MODIFIED_TIME', 14: 'PROGRESS', 15: 'PHONE', 16: 'EMAIL',
  17: 'SINGLE_SELECT', 18: 'LINK_RECORDS', 19: 'FORMULA', 20: 'LOOKUP', 21: 'TWO_WAY_LINK_RECORDS',
};
export interface Field { id: string; name: string; type_code: number; type: string; is_primary: boolean; options?: { id: string; name: string }[] }
export interface Schema { fields: Field[]; views: Raw[]; raw: Raw }
export function selectFields(schema: Schema, ids: string[]) {
  const fields = new Map(schema.fields.map(field => [field.id, field]));
  return ids.map(id => {
    const field = fields.get(id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '字段选择包含不存在或不可读取的字段 ID。');
    return field;
  });
}
export interface Chunk {
  sheetId: string; revision: number; total: number; start: number; end: number;
  records: { id: string; raw: Raw }[]; schema?: Schema; workbook: Raw[]; raw: Raw;
}
interface AssetIdentity { document_id: string; sheet_id: string; record_id: string; field_id: string; asset_id: string }
export type Locator = AssetIdentity & ({ chunk_start: number; chunk_size: number } | { source: 'record_query' });
export interface Asset {
  kind: 'image' | 'attachment'; id: string; name: string; url: string;
  size: number | null; width?: number; height?: number; extension?: string; source?: string;
}

export function parseJson(input: string, label: string): any {
  try { return JSON.parse(input); } catch { throw new WecomError('PARSE_ERROR', `${label}不是有效 JSON；没有使用截断文本代替。`); }
}

export function schemaFromRaw(raw: Raw): Schema {
  requireData(raw && raw.k3 && Array.isArray(raw.k4), '智能表格字段或视图结构不完整。');
  const fields: Field[] = Object.entries(raw.k3).map(([id, value]) => {
    const field = value as Raw;
    requireData(typeof field.k30 === 'string' && Number.isInteger(field.k31), '字段缺少名称或真实类型。');
    const type = field.k31;
    const options = field[`k${type}`]?.k3;
    return { id, name: field.k30, type_code: type, type: fieldTypes[type] || `UNKNOWN_${type}`, is_primary: raw.k9 === id,
      ...([9, 17].includes(type) && Array.isArray(options) ? { options: options.map((v: Raw) => ({ id: v.k1, name: v.k2 })) } : {}) };
  });
  const views = raw.k4.map((v: Raw) => {
    requireData(typeof v.k30 === 'string' && typeof v.k31 === 'string' && Number.isInteger(v.k32), '视图元数据不完整。');
    const properties = v[`k${v.k32}`];
    const filter = properties?.k8;
    if (filter) requireData(Array.isArray(filter.k2), '保存的视图筛选结构发生变化。');
    return { id: v.k30, name: v.k31, type_code: v.k32, records_scope_supported: 'table_only',
      saved_filter: filter ? { conjunction_code: filter.k1, conditions: filter.k2.map((c: Raw) => ({
        field_id: c.k30, field_name: fields.find(f => f.id === c.k30)?.name || null,
        field_type_code: c.k31, operator_code: c.k32, value: c[`k${c.k31}`] ?? null })) } : null,
      sort: (properties?.k9 || []).map((s: Raw) => ({ field_id: s.k1, descending: Boolean(s.k2) })),
      group: (properties?.k7 || []).map((s: Raw) => ({ field_id: s.k1, descending: Boolean(s.k2) })) };
  });
  return { fields, views, raw };
}

export function parseChunk(data: Raw, sheetId: string, requestedStart: number, requestedEnd: number): Chunk {
  requireData(data && data.padType === 'smartsheet', '响应没有确认智能表格类型。');
  if (data.dataIniting) throw new WecomError('DATA_NOT_READY', '网页接口仍在初始化数据，请稍后重新读取。');
  requireData(data.sheetId === sheetId && Number.isInteger(data.rev), '响应子表 ID 或版本不匹配。');
  const texts = data.initialAttributedText?.text;
  requireData(Array.isArray(texts) && texts.length === 1, '分块数量变化；拒绝遗漏额外数据块。');
  const text = texts[0];
  requireData(typeof text.smartsheet === 'string' && typeof text.workbook === 'string', '缺少智能表格压缩内容或子表目录。');
  let decoded: string;
  try { decoded = inflateSync(Buffer.from(text.smartsheet, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'); }
  catch { throw new WecomError('PARSE_ERROR', '智能表格内容解压失败或超过 64 MiB 安全上限。'); }
  const groups = parseJson(decoded, '智能表格压缩内容');
  requireData(Array.isArray(groups) && groups.every(Array.isArray), '智能表格命令分组结构发生变化。');
  const commands: Raw[] = groups.flat();
  requireData(commands.every(c => c.v === 5 && [3005, 3028].includes(c.t) && c.c?.k1 === sheetId), '存在未支持的智能表格命令或版本；没有静默跳过。');
  const initial = commands.filter(c => c.t === 3005);
  const deltas = commands.filter(c => c.t === 3028);
  requireData(initial.length <= 1 && deltas.length <= 1, '出现重复的表格或记录分块命令。');
  const schema = initial.length ? schemaFromRaw(initial[0].c.k3) : undefined;
  const delta = deltas[0]?.c.k2;
  const map = delta?.k1 || {};
  const ranks = delta?.k6?.k1 || initial[0]?.c.k3?.k16?.k1 || {};
  const ids = Object.keys(map);
  requireData(ids.every(id => typeof ranks[id] === 'string'), '记录缺少行顺序，不能可靠定位附件。');
  ids.sort((a, b) => ranks[a] < ranks[b] ? -1 : ranks[a] > ranks[b] ? 1 : 0);
  const { total_record_count: total, start_row_index: start, end_row_index: end } = text;
  requireData(Number.isInteger(total) && total >= 0 && Number.isInteger(start) && Number.isInteger(end), '缺少真实总数或分页范围。');
  requireData(start === requestedStart && end <= requestedEnd, '接口返回的分页范围与请求不一致。');
  const expected = Math.max(0, Math.min(end + 1, total) - start);
  if (ids.length !== expected) throw new WecomError('INCOMPLETE_DATA', '记录数量与分页范围不符；未把不完整结果作为成功返回。', { expected, actual: ids.length, start, end, total });
  const workbook = parseJson(text.workbook, '子表目录');
  requireData(Array.isArray(workbook) && workbook.every(v => typeof v.id === 'string' && typeof v.name === 'string' && typeof v.type === 'string'), '子表目录结构无效。');
  return { sheetId, revision: data.rev, total, start, end, schema, workbook, raw: delta || {}, records: ids.map(id => ({ id, raw: map[id] })) };
}

export function cellsFor(record: Raw): Raw {
  requireData(record.k1 && typeof record.k1 === 'object' && !Array.isArray(record.k1), '分块接口的记录字段映射发生变化。');
  return record.k1;
}

export function assetsFor(cell: Raw | undefined): Asset[] {
  if (!cell || ![5, 6].includes(cell.k30)) return [];
  const list = cell[`k${cell.k30}`];
  if (list === undefined) return [];
  requireData(Array.isArray(list), '图片或附件字段不是数组，无法证明文件完整性。');
  return list.map((f: Raw): Asset => {
    if (cell.k30 === 5) {
      requireData(typeof f.k1 === 'string' && typeof f.k2 === 'string' && typeof f.k3 === 'string', '图片缺少真实 ID、文件名或地址。');
      return { kind: 'image', id: f.k1, name: f.k2, url: f.k3, size: null,
        ...(typeof f.k4 === 'number' ? { width: f.k4 } : {}), ...(typeof f.k5 === 'number' ? { height: f.k5 } : {}) };
    }
    requireData(typeof f.k4 === 'string' && typeof f.k1 === 'string' && typeof f.k6 === 'string', '附件缺少真实文件 ID、文件名或来源地址。');
    return { kind: 'attachment', id: f.k4, name: f.k1, url: f.k6, size: typeof f.k2 === 'number' ? f.k2 : null,
      extension: f.k3, source: f.k7 };
  });
}

const derivedFormatterTypes: Record<number, string> = {
  1: 'TEXT', 2: 'NUMBER', 3: 'CHECKBOX', 4: 'DATE_TIME', 7: 'USER', 9: 'MULTIPLE_SELECT',
  14: 'PROGRESS', 16: 'EMAIL', 17: 'SINGLE_SELECT', 26: 'CURRENCY', 28: 'PERCENT',
};

function formatCode(value: unknown) {
  return typeof value === 'number' || (typeof value === 'string' && value.length > 0) ? value : null;
}

export function formatterTypeName(code: unknown) {
  if (typeof code === 'number') return derivedFormatterTypes[code] || `UNKNOWN_${code}`;
  if (typeof code === 'string' && /^-?\d+$/.test(code)) {
    const numeric = Number(code);
    return derivedFormatterTypes[numeric] || `UNKNOWN_${code}`;
  }
  return null;
}

function derivedItem(item: Raw) {
  const formatterType = formatCode(item?.formatterType ?? item?.formatter_type);
  const resultType = formatterTypeName(formatterType);
  const output: Raw = { text: typeof item?.text === 'string' ? item.text : null,
    formatter_type: formatterType, result_type: resultType };
  for (const [sources, target] of [
    [['number'], 'number'], [['formattedNumber', 'formatted_number'], 'formatted_number'],
    [['timestamp'], 'timestamp'], [['decimalPlaces', 'decimal_places'], 'decimal_places'],
  ] as [string[], string][]) {
    const source = sources.find(key => typeof item?.[key] === 'number');
    if (source) output[target] = item[source];
  }
  if (typeof item?.checked === 'boolean') output.checked = item.checked;
  if (typeof item?.link === 'string' && item.link) output.link = item.link;
  if (typeof item?.id === 'string') {
    if (resultType === 'USER') {
      output.member = { id: item.id, name: typeof item.name === 'string' ? item.name : null,
        avatar_url: typeof (item.avatarUrl ?? item.avatar_url) === 'string' ? (item.avatarUrl ?? item.avatar_url) : null,
        namespace: 'wecom_uid' };
    } else {
      output.option_id = item.id;
    }
  }
  if (item?.isError) output.error = { type: typeof (item.errorType ?? item.error_type) === 'number' ? (item.errorType ?? item.error_type) : null,
    message: typeof (item.errorMessage ?? item.error_message) === 'string' ? (item.errorMessage ?? item.error_message) : null,
    args: Array.isArray(item.errorMessageArgs ?? item.error_message_args) ? (item.errorMessageArgs ?? item.error_message_args) : null };
  return output;
}

type DecodedDerived = { ok: true; parsed: Raw } | { ok: false; error: 'invalid_json' | 'missing_data';
  value: unknown; parsed: unknown; failure: FailurePosition };

interface FailurePosition { position: number | null; line: number | null; column: number | null }

// 仅从 JSON.parse 的错误信息读取位置，不保留错误消息本身（可能包含原始片段）。
function failurePosition(error: unknown): FailurePosition {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message);
  const line = /line (\d+)/.exec(message);
  const column = /column (\d+)/.exec(message);
  return { position: position ? Number(position[1]) : null,
    line: line ? Number(line[1]) : null, column: column ? Number(column[1]) : null };
}

// 第一步：只负责把不同原始形态解码为同一对象，不解释业务语义。
function decodeDerivedPayload(value: unknown): DecodedDerived {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (error) {
      return { ok: false, error: 'invalid_json', value, parsed: null, failure: failurePosition(error) };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'missing_data', value, parsed, failure: failurePosition(null) };
  }
  const candidate = parsed as Raw;
  if (!Array.isArray(candidate.data) && !Array.isArray(candidate.items)) {
    return { ok: false, error: 'missing_data', value, parsed, failure: failurePosition(null) };
  }
  return { ok: true, parsed: candidate };
}

function stableDerived(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDerived).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Raw).sort().map(key =>
      `${JSON.stringify(key)}:${stableDerived((value as Raw)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// 第二步：两种原始形态共用同一标准化入口，输出可比较的标准结构。
function normalizeDerived(parsed: Raw): Raw {
  const rawItems: Raw[] = Array.isArray(parsed.data) ? parsed.data : parsed.items;
  const items = rawItems.map(derivedItem);
  const errors = items.filter(item => item.error);
  const members = items.filter(item => item.member).map(item => item.member);
  const options = items.filter(item => item.option_id).map(item => ({ id: item.option_id, text: item.text }));
  const resultTypes = [...new Set(items.map(item => item.result_type).filter(Boolean))];
  const resultType = resultTypes.length === 1 ? resultTypes[0] : null;
  // 空值合并而不是真假判断：0、false、空字符串都保留为真实结果。
  const primary = (item: Raw) => item.number ?? item.timestamp ?? item.checked ?? item.text ?? null;
  const status = errors.length ? 'error' : items.length ? 'present' : 'empty';
  return {
    status,
    value: items.length === 0 ? [] : items.length === 1 ? primary(items[0]) : items.map(primary),
    result_type: resultType,
    ...(items.length === 1 ? { display_text: items[0].text }
      : items.length > 1 ? { display_texts: items.map(item => item.text) } : {}),
    ...(resultTypes.length > 1 ? { result_types: resultTypes } : {}),
    items,
    computed_result: { source_type: typeof (parsed.sourceType ?? parsed.source_type) === 'number'
      ? (parsed.sourceType ?? parsed.source_type) : null,
    formatter_type: items[0]?.formatter_type ?? null, result_type: resultType, data: items },
    ...(members.length ? { members } : {}),
    ...(options.length ? { options } : {}),
    ...(errors.length ? { errors: errors.map(item => item.error) } : {}),
  };
}

export interface DerivedContext {
  read_path?: 'whole_table' | 'query' | 'view' | 'write_verification' | 'unknown';
  revision?: number;
  document_id?: string;
  sheet_id?: string;
  field_id?: string;
  field_type?: string;
  field_type_code?: number;
}

const diagnosticsSnippetLimit = 160;

// 只有显式开启本地诊断模式才保存片段；默认只保留哈希与长度。
function localDiagnosticsEnabled() {
  return ['1', 'true', 'yes'].includes((process.env.WECOM_MCP_DIAGNOSTICS || '').trim().toLowerCase());
}

// 脱敏顺序：先去掉链接与人员/凭据字段，再抹掉长 token，最后才截断。
function redactDiagnosticText(text: string) {
  return text
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, '[url]')
    .replace(/"(name|memberName|userName|avatarUrl|avatar_url|phone|email)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(sid|wedoc_sid|wedoc_xsrf|token|access_token|cookie|signature|secret|password|key)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"')
    .replace(/\b(sid|wedoc_sid|wedoc_xsrf|access_token|signature|secret|password)=[^\s,;&"']+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

function diagnosticsSnippet(text: string) {
  const redacted = redactDiagnosticText(text);
  return { text: redacted.slice(0, diagnosticsSnippetLimit), limit: diagnosticsSnippetLimit,
    truncated: redacted.length > diagnosticsSnippetLimit, redacted: true };
}

// 合法但结构不符的 payload 仍可能带有 formatterType，失败时一并记录上下文。
function formatterContext(parsed: unknown) {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Raw;
  if (typeof record.formatterType === 'number') return record.formatterType;
  const first = Array.isArray(record.data) ? record.data[0] : Array.isArray(record.items) ? record.items[0] : undefined;
  return first && typeof first.formatterType === 'number' ? first.formatterType : null;
}

function buildIdentity() {
  try { const build = runningBuild(); return { build_id: build.build_id, build_commit: build.build_commit }; }
  catch { return { build_id: 'unknown', build_commit: 'unknown' }; }
}

function parseDiagnostics(decoded: Extract<DecodedDerived, { ok: false }>, source: 'k36.k1' | 'k3601',
  context: DerivedContext) {
  // 字符串按原样计长度与哈希；对象/数组按稳定序列化计算，避免键顺序造成指纹漂移。
  const serialized = typeof decoded.value === 'string' ? decoded.value : stableDerived(decoded.value) ?? '';
  const enabled = localDiagnosticsEnabled();
  return {
    read_path: context.read_path || 'unknown',
    revision: context.revision ?? null,
    document_id: context.document_id ?? null,
    sheet_id: context.sheet_id ?? null,
    field_id: context.field_id ?? null,
    field_type: context.field_type ?? null,
    field_type_code: context.field_type_code ?? null,
    formatter_type: formatterContext(decoded.parsed),
    source,
    failure: decoded.error,
    raw_type: decoded.value === null ? 'null' : Array.isArray(decoded.value) ? 'array' : typeof decoded.value,
    raw_length: serialized.length,
    raw_sha256: createHash('sha256').update(serialized).digest('hex'),
    failure_position: decoded.failure.position,
    failure_line: decoded.failure.line,
    failure_column: decoded.failure.column,
    ...buildIdentity(),
    raw_content_included: enabled,
    ...(enabled ? { raw_snippet: diagnosticsSnippet(serialized) } : {}),
  };
}

function parseError(decoded: Extract<DecodedDerived, { ok: false }>, source: 'k36.k1' | 'k3601',
  context: DerivedContext = {}, alternateValid = false) {
  return { status: 'parse_error', value: null, result_type: null, computed_result: null, items: [],
    parse_error: decoded.error, parse_error_source: source, ...(alternateValid ? { alternate_valid: true } : {}),
    parse_diagnostics: parseDiagnostics(decoded, source, context) };
}

// 首选来源可用但旧来源解析失败时，失败诊断同样可定位，不改变字段整体成功状态。
function alternateParseError(decoded: Extract<DecodedDerived, { ok: false }>, context: DerivedContext) {
  return { source: 'k3601', parse_error: decoded.error,
    parse_diagnostics: parseDiagnostics(decoded, 'k3601', context) };
}

// LOOKUP/FORMULA 的计算结果保存在 k36.k1（JSON 字符串），旧接口也使用 k3601（对象或字符串）。
// 不能用 status=unresolved 代替：空结果、计算错误和待计算必须分别报告。
// 优先级：k36.k1 存在且可解析时使用它；两源语义冲突时保留首选值并报告 source_conflict。
// k36.k1 解析失败时不回退掩盖错误；只有 k36.k1 缺失时才使用 k3601。
export function parseDerivedResult(cell: Raw | undefined, context: DerivedContext = {}) {
  if (!cell) return null;
  const standard = cell.k36?.k1;
  const legacy = cell.k3601;
  const hasStandard = standard !== undefined && standard !== null;
  const hasLegacy = legacy !== undefined && legacy !== null;
  if (!hasStandard && !hasLegacy) {
    return cell.k36 ? { status: 'pending', value: null, result_type: null, computed_result: null } : null;
  }
  const standardDecoded = hasStandard ? decodeDerivedPayload(standard) : null;
  const legacyDecoded = hasLegacy ? decodeDerivedPayload(legacy) : null;
  if (standardDecoded && !standardDecoded.ok) {
    return { ...parseError(standardDecoded, 'k36.k1', context, Boolean(legacyDecoded?.ok)),
      ...(legacyDecoded && !legacyDecoded.ok
        ? { alternate_parse_error: alternateParseError(legacyDecoded, context) } : {}) };
  }
  const parsed = standardDecoded?.ok ? standardDecoded.parsed : legacyDecoded?.ok ? legacyDecoded.parsed : null;
  if (!parsed) {
    if (legacyDecoded && !legacyDecoded.ok) return parseError(legacyDecoded, 'k3601', context);
    return cell.k36 ? { status: 'pending', value: null, result_type: null, computed_result: null } : null;
  }
  const normalized = normalizeDerived(parsed);
  if (standardDecoded?.ok && legacyDecoded?.ok
    && stableDerived(normalized) !== stableDerived(normalizeDerived(legacyDecoded.parsed))) {
    normalized.source_conflict = { preferred: 'k36.k1', alternate: 'k3601' };
  } else if (standardDecoded?.ok && legacyDecoded && !legacyDecoded.ok) {
    // 首选来源可用，但另一来源解析失败也必须显式报告，不能静默丢弃。
    normalized.alternate_parse_error = alternateParseError(legacyDecoded, context);
  }
  return normalized;
}

export function presentRecord(chunk: Pick<Chunk, 'sheetId' | 'raw'> & Partial<Pick<Chunk, 'start' | 'end'>>, schema: Schema, row: { id: string; raw: Raw }, docId: string, selected: string[], includeTextFragments = false, context: DerivedContext = {}) {
  requireData((chunk.start === undefined) === (chunk.end === undefined), '附件定位器的整表分块范围不完整。');
  const location = chunk.start !== undefined && chunk.end !== undefined
    ? { chunk_start: chunk.start, chunk_size: chunk.end - chunk.start + 1 }
    : { source: 'record_query' as const };
  const cells = cellsFor(row.raw);
  const fieldsById = new Map(schema.fields.map(field => [field.id, field]));
  requireData(Object.keys(cells).every(id => fieldsById.has(id)), '记录中出现字段定义未包含的字段，拒绝静默遗漏。');
  const values: Raw = {};
  for (const id of selected) {
    const field = fieldsById.get(id);
    requireData(field, '选择的字段不在当前表结构中。');
    const cell = cells[field.id];
    if (cell) requireData(cell.k30 === field.type_code, '记录字段类型与字段定义不一致。');
    if ([5, 6].includes(field.type_code)) {
      values[field.id] = { status: cell ? 'present' : 'not_returned', assets: assetsFor(cell).map(asset => {
        const { url: _privateUrl, ...publicAsset } = asset;
        return { ...publicAsset, locator: { document_id: docId, sheet_id: chunk.sheetId, record_id: row.id,
          ...location, field_id: field.id, asset_id: asset.id } satisfies Locator };
      }) };
    } else if (field.type_code === 10) {
      const created = chunk.raw.k2?.[row.id];
      values[field.id] = { status: created ? 'present' : 'unavailable', value: created?.k2 || null };
    } else if (field.type_code === 1) {
      const fragments = cell?.k1;
      if (fragments !== undefined) requireData(Array.isArray(fragments) && fragments.every(v => typeof v.k2 === 'string'), '文本片段结构变化。');
      const text = (fragments || []).map((v: Raw) => v.k2).join('');
      values[field.id] = { status: cell ? 'present' : 'not_returned', text, ...(includeTextFragments ? { fragments: fragments || [] } : {}),
        text_links: [...new Set<string>(text.match(/https?:\/\/[^\s<>]+/g) || [])].map(url => ({ url, kind: 'text_link', downloadable_as_attachment: false })) };
    } else if (field.type_code === 7) {
      // 人员字段同时保留原始值（兼容旧调用）与语义化身份引用；姓名只用于展示。
      const member = parseMemberCell(cell);
      const value = cell?.['7'] ?? cell?.k7;
      values[field.id] = { status: member.status, value: value ?? null, members: member.members,
        namespace_status: member.namespace_status, ...(member.unresolved.length ? { unresolved_members: member.unresolved } : {}) };
    } else if ([19, 20].includes(field.type_code)) {
      // FORMULA/LOOKUP 的 k36 标准单元格：保留返回类型、成员/选项引用及错误/空/待计算状态。
      values[field.id] = parseDerivedResult(cell, { ...context, document_id: context.document_id ?? docId,
        sheet_id: context.sheet_id ?? chunk.sheetId, field_id: field.id, field_type: field.type,
        field_type_code: field.type_code }) ?? { status: cell ? 'unresolved' : 'not_returned', value: null,
        result_type: null, computed_result: null };
    } else {
      const value = cell?.[`k${field.type_code}`];
      values[field.id] = { status: value !== undefined ? 'present' : cell ? 'unresolved' : 'not_returned', value: value ?? null,
        ...([9, 17].includes(field.type_code) && Array.isArray(value) ? { options: value.map(id => ({ id, name: field.options?.find(o => o.id === id)?.name || null })) } : {}),
        ...(cell?.k3601 ? { computed_result: parseJson(cell.k3601, '派生字段结果') } : {}) };
    }
  }
  return { id: row.id, fields: values };
}
