import { createHash } from 'node:crypto';
import { fieldSupport, type FieldSupport } from './capabilities.js';
import type { Field, Schema } from './protocol.js';

type Raw = Record<string, any>;

export type AttributeStatus = 'verified' | 'inferred' | 'unverified' | 'not_applicable';

export interface NormalizedField {
  id: string;
  name: string;
  type: string;
  type_code: number;
  is_primary: boolean;
  origin: 'business' | 'system' | 'derived' | 'unknown';
  writable_cell: boolean;
  options?: { id: string; name: string; style: number | null }[];
  attributes: FieldAttributes | null;
  attribute_status: AttributeStatus;
  dependencies: string[];
  target_sheet_ids: string[];
  unparsed_attribute_keys: string[];
  support: FieldSupport;
  config_digest: string;
}

export type FieldAttributes =
  | { kind: 'TEXT'; rich_text: boolean | null }
  | { kind: 'NUMBER'; decimal_places: number | null; use_separator: boolean | null; unparsed_flags: Record<string, unknown> }
  | { kind: 'CHECKBOX'; default_checked: boolean | null }
  | { kind: 'DATE_TIME'; format: string | null; auto_fill: boolean | null }
  | { kind: 'PROGRESS'; decimal_places: number | null; range: [number, number] | null; percentage: boolean | null }
  | { kind: 'SELECT'; multiple: boolean; quick_add: boolean | null }
  | { kind: 'USER'; multiple: boolean | null; notify_when_added: boolean | null; raw_flags: { k1: boolean | null; k2: boolean | null }; semantics: 'verified' | 'inferred' }
  | { kind: 'URL'; display_style: string | null }
  | { kind: 'ASSET'; multiple: true; display_mode: string | null }
  | { kind: 'SYSTEM'; read_only: true }
  | { kind: 'RELATION'; target_sheet_id: string | null; multiple: boolean | null; two_way: boolean | null }
  | { kind: 'FORMULA'; tokens: { type: number; text?: string; field_id?: string }[] }
  | { kind: 'LOOKUP'; target_sheet_id: string | null; target_field_id: string | null; aggregation: string;
      conditions: { target_field_id: string; local_field_id: string; operator_code: number | null }[] }
  | { kind: 'UNKNOWN'; type_code: number };

function isObject(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function scalarFlags(config: Raw | undefined, known: string[]): Record<string, unknown> {
  if (!config) return {};
  return Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    !known.includes(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')));
}

// 只提取能由字段定义确认的引用：配置中出现的字段 ID 与子表 ID。
// 不解释未知键的语义，因此派生依赖可能不完整，必须配合 attribute_status 阅读。
function references(config: unknown, fieldIds: Set<string>, sheetIds: Set<string>) {
  const fields = new Set<string>();
  const sheets = new Set<string>();
  const seen = new WeakSet<object>();
  let depth = 0;
  const walk = (value: unknown) => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    depth += 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else {
      for (const item of Object.values(value as Raw)) {
        if (typeof item === 'string') {
          if (fieldIds.has(item)) fields.add(item);
          if (sheetIds.has(item)) sheets.add(item);
        } else walk(item);
      }
    }
    depth -= 1;
  };
  walk(config);
  return { fields: [...fields], sheets: [...sheets] };
}

function selectAttributes(field: Raw, config: Raw | undefined): FieldAttributes {
  return { kind: 'SELECT', multiple: field.k31 === 9, quick_add: boolOrNull(config?.k1) };
}

function attributesFor(field: Raw, type: string): { attributes: FieldAttributes | null; status: AttributeStatus; unparsed: string[] } {
  const config = field[`k${field.k31}`];
  switch (type) {
    case 'TEXT':
      return { attributes: { kind: 'TEXT', rich_text: isObject(config) ? (typeof config.k9 === 'object' ? true : null) : null },
        status: 'inferred', unparsed: [] };
    case 'NUMBER': {
      const known = ['k1', 'k2', 'k3', 'k9'];
      return { attributes: { kind: 'NUMBER', decimal_places: numberOrNull(config?.k1), use_separator: boolOrNull(config?.k2),
        unparsed_flags: scalarFlags(config, known) }, status: 'inferred', unparsed: Object.keys(config || {}).filter(key => !known.includes(key)) };
    }
    case 'CHECKBOX':
      return { attributes: { kind: 'CHECKBOX', default_checked: boolOrNull(config?.k1) }, status: 'inferred', unparsed: [] };
    case 'DATE_TIME':
      return { attributes: { kind: 'DATE_TIME', format: stringOrNull(config?.k1), auto_fill: boolOrNull(config?.k2) },
        status: 'inferred', unparsed: Object.keys(config || {}).filter(key => !['k1', 'k2'].includes(key)) };
    case 'PROGRESS': {
      const range = Array.isArray(config?.k5) && config.k5.length === 2 && config.k5.every((value: unknown) => typeof value === 'number')
        ? [config.k5[0], config.k5[1]] as [number, number] : null;
      return { attributes: { kind: 'PROGRESS', decimal_places: numberOrNull(config?.k1), range,
        percentage: typeof config?.k4 === 'number' ? config.k4 === 0 : null }, status: 'inferred',
        unparsed: Object.keys(config || {}).filter(key => !['k1', 'k4', 'k5'].includes(key)) };
    }
    case 'SINGLE_SELECT':
    case 'MULTIPLE_SELECT':
      return { attributes: selectAttributes(field, config), status: 'inferred', unparsed: Object.keys(config || {}).filter(key => !['k1', 'k2', 'k3', 'k9'].includes(key)) };
    case 'USER': {
      const flags = { k1: boolOrNull(config?.k1), k2: boolOrNull(config?.k2) };
      // 真实写入实验：开启“允许多选”后 k1 变为 true、k2 保持 false；因此 k1=多选，k2=添加时通知。
      return { attributes: { kind: 'USER', multiple: flags.k1, notify_when_added: flags.k2, raw_flags: flags, semantics: 'verified' },
        status: 'verified', unparsed: Object.keys(config || {}).filter(key => !['k1', 'k2'].includes(key)) };
    }
    case 'URL':
      return { attributes: { kind: 'URL', display_style: stringOrNull(config?.k1) }, status: 'unverified',
        unparsed: Object.keys(config || {}) };
    case 'IMAGE':
    case 'ATTACHMENT':
      return { attributes: { kind: 'ASSET', multiple: true, display_mode: stringOrNull(config?.k1) }, status: 'unverified',
        unparsed: Object.keys(config || {}).filter(key => key !== 'k1') };
    case 'CREATED_USER':
    case 'MODIFIED_USER':
    case 'CREATED_TIME':
    case 'MODIFIED_TIME':
      return { attributes: { kind: 'SYSTEM', read_only: true }, status: 'verified', unparsed: Object.keys(config || {}) };
    case 'LINK_RECORDS':
    case 'TWO_WAY_LINK_RECORDS':
      return { attributes: { kind: 'RELATION', target_sheet_id: stringOrNull(config?.k2),
        multiple: boolOrNull(config?.k4), two_way: field.type === 'TWO_WAY_LINK_RECORDS' }, status: 'verified',
        unparsed: Object.keys(config || {}).filter(key => !['k1', 'k2', 'k4', 'k7'].includes(key)) };
    case 'FORMULA': {
      const tokens = Array.isArray(config?.k1) ? config.k1.filter(isObject).map((token: Raw) => ({
        type: numberOrNull(token.k1) ?? 0,
        ...(typeof token.k2 === 'string' ? { text: token.k2 } : {}),
        ...(typeof token.k3 === 'string' ? { field_id: token.k3 } : {}),
      })) : [];
      return { attributes: { kind: 'FORMULA', tokens }, status: 'verified',
        unparsed: Object.keys(config || {}).filter(key => key !== 'k1') };
    }
    case 'LOOKUP': {
      const aggregationCodes: Record<number, string> = { 0: 'values', 3: 'count', 4: 'count_unique' };
      const conditions = Array.isArray(config?.k6?.k2) ? config.k6.k2.filter(isObject).map((condition: Raw) => ({
        target_field_id: typeof condition.k2 === 'string' ? condition.k2 : '',
        local_field_id: typeof condition.k5?.k2 === 'string' ? condition.k5.k2 : '',
        operator_code: numberOrNull(condition.k3),
      })) : [];
      return { attributes: { kind: 'LOOKUP', target_sheet_id: stringOrNull(config?.k5),
        target_field_id: stringOrNull(config?.k2),
        aggregation: aggregationCodes[numberOrNull(config?.k3) ?? -1] || 'unknown', conditions }, status: 'verified',
        unparsed: Object.keys(config || {}).filter(key => !['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'].includes(key)) };
    }
    default:
      return { attributes: { kind: 'UNKNOWN', type_code: field.k31 }, status: 'unverified', unparsed: Object.keys(config || {}) };
  }
}

function originFor(type: string): NormalizedField['origin'] {
  if (['CREATED_USER', 'MODIFIED_USER', 'CREATED_TIME', 'MODIFIED_TIME'].includes(type)) return 'system';
  if (['FORMULA', 'LOOKUP'].includes(type)) return 'derived';
  if (type.startsWith('UNKNOWN_')) return 'unknown';
  return 'business';
}

export function normalizeField(schema: Schema, field: Field, fieldIds: Set<string>, sheetIds: Set<string>): NormalizedField {
  const raw = schema.raw.k3[field.id];
  const { attributes, status, unparsed } = attributesFor(raw || {}, field.type);
  const config = raw?.[`k${raw.k31}`];
  const refs = config ? references(config, fieldIds, sheetIds) : { fields: [], sheets: [] };
  const styles = new Map<string, number | null>();
  if (Array.isArray(config?.k3)) {
    for (const option of config.k3) if (isObject(option) && typeof option.k1 === 'string') {
      styles.set(option.k1, typeof option.k3 === 'number' ? option.k3 : null);
    }
  }
  const rootUnknown = Object.keys(raw || {}).filter(key => !['k30', 'k31', `k${raw.k31}`].includes(key));
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    type_code: field.type_code,
    is_primary: field.is_primary,
    origin: originFor(field.type),
    writable_cell: fieldSupport(field.type).write_cell === 'verified',
    ...(field.options ? { options: field.options.map(option => ({
      id: option.id, name: option.name, style: styles.get(option.id) ?? null,
    })) } : {}),
    attributes,
    attribute_status: status,
    dependencies: refs.fields.filter(id => id !== field.id),
    target_sheet_ids: refs.sheets,
    unparsed_attribute_keys: [...new Set([...unparsed, ...rootUnknown])].sort(),
    support: fieldSupport(field.type),
    config_digest: createHash('sha256').update(JSON.stringify(config ?? null)).digest('hex'),
  };
}

export function normalizeFields(schema: Schema, sheetIds: string[] = []): NormalizedField[] {
  const fieldIds = new Set(schema.fields.map(field => field.id));
  const sheets = new Set(sheetIds);
  return schema.fields.map(field => normalizeField(schema, field, fieldIds, sheets));
}

// 依赖环检测只依据已识别的字段 ID 引用；未知配置可能造成漏报。
export function dependencyCycles(fields: Pick<NormalizedField, 'id' | 'dependencies'>[]): string[][] {
  const graph = new Map(fields.map(field => [field.id, field.dependencies.filter(id => fields.some(other => other.id === id))]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of graph.get(id) || []) visit(next);
    stack.pop();
    state.set(id, 'done');
  };
  for (const field of fields) visit(field.id);
  return cycles;
}

export function affectedDependents(fields: Pick<NormalizedField, 'id' | 'dependencies'>[], changed: string[]): string[] {
  const result = new Set<string>(changed);
  let added = true;
  while (added) {
    added = false;
    for (const field of fields) {
      if (!result.has(field.id) && field.dependencies.some(id => result.has(id))) {
        result.add(field.id); added = true;
      }
    }
  }
  return [...result].filter(id => !changed.includes(id));
}

export function userFieldMultiple(field: NormalizedField): boolean | null {
  return field.type === 'USER' && field.attributes?.kind === 'USER' ? field.attributes.multiple : null;
}
