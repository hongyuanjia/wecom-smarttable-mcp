import { randomInt } from 'node:crypto';
import { WecomError } from './errors.js';
import { columnOrders, mutation, newId, type Mutation } from './mutations.js';
import type { Schema } from './protocol.js';
import type { ProviderFormulaToken } from './formulas.js';

type Raw = Record<string, any>;

export interface LookupCondition {
  target_field_id: string;
  target_field_type: number;
  operator_code: number;
  local_field_id?: string;
  value?: string | number | boolean | string[];
}
export interface LookupSpec {
  target_sheet_id: string;
  target_field_id: string;
  aggregation: 'values' | 'unique' | 'sum' | 'count' | 'count_unique' | 'average' | 'max' | 'min';
  conditions: LookupCondition[];
  /** 沿来源表的单向/双向关联字段引用目标字段；为空时使用条件匹配。 */
  relation_field_id?: string;
}

export interface RelationSpec {
  target_sheet_id: string;
  multiple: boolean;
  two_way?: boolean;
}

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function conditionId() {
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function insertionIndexes(schema: Schema) {
  return Object.fromEntries(Object.entries(columnOrders(schema)).map(([viewId, fields]) => [viewId, fields.length]));
}

function widthMutations(sheetId: string, indexes: Record<string, number>, fieldId: string, width: number) {
  return Object.keys(indexes).map(viewId => mutation(3024, { '1': sheetId, '2': viewId, '3': fieldId, '4': { '1': width } }));
}

function newFieldId(schema: Schema) {
  const id = newId('f');
  if (schema.fields.some(field => field.id === id)) throw new WecomError('ID_COLLISION', '随机字段 ID 与已有字段重复，尚未提交。');
  return id;
}

const aggregationCode: Record<LookupSpec['aggregation'], number> = {
  values: 0, unique: 1, sum: 2, count: 3, count_unique: 4, average: 5, max: 6, min: 7,
};
const numberDisplay = { '1': 2, '2': { '2': { '1': -1, '2': false, '3': true, '9': {} } } };
const aggregationDisplay: Record<LookupSpec['aggregation'], Raw> = {
  values: { '1': 1, '2': { '1': { '9': { '1': null } } } },
  unique: { '1': 1, '2': { '1': { '9': { '1': null } } } },
  sum: numberDisplay, average: numberDisplay, max: numberDisplay, min: numberDisplay,
  count: numberDisplay, count_unique: numberDisplay,
};

export function lookupFieldMutations(sheetId: string, schema: Schema, name: string, spec: LookupSpec) {
  if (schema.fields.some(field => field.name === name)) throw new WecomError('DUPLICATE_FIELD_NAME', '新字段名称与已有字段重名。', { name });
  if (spec.relation_field_id ? spec.conditions.length : !spec.conditions.length) {
    throw new WecomError('INVALID_ARGUMENT', spec.relation_field_id
      ? '沿关联字段引用不能同时提供条件匹配。' : '查找引用至少需要一个匹配条件。');
  }
  const fieldId = newFieldId(schema);
  const indexes = insertionIndexes(schema);
  const property = spec.relation_field_id
    ? {
      // 网页端 DEFAULT 模式：k1=关联字段，k4=upgradeType(0)，k5 为空，k6 为空条件。
      '1': spec.relation_field_id, '2': spec.target_field_id, '3': aggregationCode[spec.aggregation],
      '4': 0, '5': '', '6': { '1': 1, '2': [] }, '7': aggregationDisplay[spec.aggregation],
    }
    : {
      '1': '', '2': spec.target_field_id, '3': aggregationCode[spec.aggregation], '4': 1, '5': spec.target_sheet_id,
      '6': { '1': 1, '2': spec.conditions.map(condition => {
        const base: Raw = {
          '1': conditionId(), '2': condition.target_field_id,
          '3': condition.target_field_type, '4': condition.operator_code,
        };
        if (condition.local_field_id) {
          base['5'] = { '1': 1, '2': condition.local_field_id };
        } else {
          const wrapper: Raw = {};
          wrapper[String(condition.target_field_type)] = condition.value;
          base['5'] = { '1': 0, '3': wrapper, '4': condition.target_field_type };
        }
        return base;
      }) },
      '7': aggregationDisplay[spec.aggregation],
    };
  const insert = mutation(3014, { '1': sheetId, '3': { '1': fieldId, '2': 20, '3': name, '4': indexes }, '4': false });
  const config = mutation(3017, { '1': sheetId, '3': fieldId, '4': { '20': property, '31': 20 }, '5': null, '6': false });
  return {
    field: { id: fieldId, name, type_code: 20, type: 'LOOKUP', target_sheet_id: spec.target_sheet_id,
      target_field_id: spec.target_field_id, aggregation: spec.aggregation, conditions: spec.conditions,
      ...(spec.relation_field_id ? { relation_field_id: spec.relation_field_id } : {}) },
    expected: { '20': property, '31': 20 },
    mutations: [insert, config, ...widthMutations(sheetId, indexes, fieldId, 120)],
  };
}

export function relationFieldMutations(docId: string, sheetId: string, schema: Schema, name: string, spec: RelationSpec) {
  if (schema.fields.some(field => field.name === name)) throw new WecomError('DUPLICATE_FIELD_NAME', '新字段名称与已有字段重名。', { name });
  const fieldId = newFieldId(schema);
  const indexes = insertionIndexes(schema);
  const twoWay = spec.two_way === true;
  const type = twoWay ? 21 : 18;
  const backFieldId = twoWay ? newFieldId(schema) : undefined;
  const property = twoWay
    ? { '1': docId, '2': spec.target_sheet_id, '4': spec.multiple, '6': backFieldId, '7': 1 }
    : { '1': docId, '2': spec.target_sheet_id, '4': spec.multiple, '7': 1 };
  const insert = mutation(3014, { '1': sheetId, '3': { '1': fieldId, '2': type, '3': name, '4': indexes }, '4': twoWay });
  const config = mutation(3017, { '1': sheetId, '3': fieldId, '4': { [String(type)]: property, '31': type }, '5': null, '6': twoWay });
  return {
    field: { id: fieldId, name, type_code: type, type: twoWay ? 'TWO_WAY_LINK_RECORDS' : 'LINK_RECORDS',
      target_sheet_id: spec.target_sheet_id, multiple: spec.multiple, ...(backFieldId ? { back_field_id: backFieldId } : {}) },
    expected: { [String(type)]: property, '31': type },
    mutations: [insert, config, ...widthMutations(sheetId, indexes, fieldId, 180)],
  };
}

export type FormulaFormatName = 'text' | 'number' | 'percent' | 'currency' | 'date' | 'checkbox' | 'email' | 'progress';
export interface FormulaFormatSpec {
  type: FormulaFormatName;
  decimal_places?: number;
  use_separator?: boolean;
  date_format?: string;
}

export function formulaFormatter(format?: FormulaFormatSpec) {
  if (!format) return undefined;
  const decimal = format.decimal_places ?? -1;
  const separator = format.use_separator ?? false;
  switch (format.type) {
    case 'text': return { '1': 1, '2': { '1': { '9': {} } } };
    case 'number': return { '1': 2, '2': { '2': { '1': decimal, '2': separator, '3': true, '9': {} } } };
    case 'percent': return { '1': 28, '2': { '28': { '1': decimal, '2': separator, '3': true, '9': {} } } };
    case 'currency': return { '1': 26, '2': { '26': { '1': 1, '2': 2, '3': true, '4': false, '9': {} } } };
    case 'date': return { '1': 4, '2': { '4': { '1': format.date_format ?? 'yyyy"年"m"月"d"日"', '2': false } } };
    case 'checkbox': return { '1': 3, '2': { '3': { '1': false, '2': { '1': 1, '2': 16 } } } };
    case 'email': return { '1': 16, '2': { '16': { '9': {} } } };
    case 'progress': return { '1': 14, '2': { '14': { '1': decimal, '2': { '1': 1, '2': [16] }, '3': true, '4': 0, '5': [0, 1], '6': false, '9': {} } } };
  }
}

export function formulaFormatterMatches(actual: Raw | undefined, expected: Raw | undefined) {
  if (!expected) return true;
  // 写入用数字键，回读统一为 k 前缀键；比较前转换。
  const want = prefixReadbackKeys(expected) as Raw;
  if (!actual || actual.k1 !== want.k1) return false;
  return partialRawMatch(want.k2, actual.k2);
}

function prefixReadbackKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prefixReadbackKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Raw).map(([key, item]) => [
    /^\d+$/.test(key) ? `k${key}` : key, prefixReadbackKeys(item),
  ]));
}

function partialRawMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (arrLike(expected)) {
    return arrLike(actual) && expected.length === actual.length
      && expected.every((value, index) => partialRawMatch(value, actual[index]));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected as Raw).every(([key, value]) => partialRawMatch(value, (actual as Raw)[key]));
}

function arrLike(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function formulaFieldMutations(sheetId: string, schema: Schema, name: string, tokens: ProviderFormulaToken[], formatter?: Raw) {
  if (schema.fields.some(field => field.name === name)) throw new WecomError('DUPLICATE_FIELD_NAME', '新字段名称与已有字段重名。', { name });
  const fieldId = newFieldId(schema);
  const indexes = insertionIndexes(schema);
  const insert = mutation(3014, { '1': sheetId, '3': { '1': fieldId, '2': 19, '3': name, '4': indexes }, '4': false });
  const property = { '1': tokens, ...(formatter ? { '2': formatter } : {}) };
  const config = mutation(3017, { '1': sheetId, '3': fieldId, '4': { '19': property, '31': 19 }, '5': null, '6': false });
  return {
    field: { id: fieldId, name, type_code: 19, type: 'FORMULA', tokens },
    expected: { '19': property, '31': 19 },
    mutations: [insert, config, ...widthMutations(sheetId, indexes, fieldId, 140)],
  };
}

export function fieldConfigMatches(raw: Raw | undefined, typeCode: number, expected: Raw) {
  if (!raw || raw.k31 !== typeCode) return false;
  const config = raw[`k${typeCode}`];
  return JSON.stringify(config) === JSON.stringify(expected);
}
