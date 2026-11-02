import { createHash } from 'node:crypto';
import { requireData, WecomError } from './errors.js';
import { parseJson, type Schema } from './protocol.js';

export type QueryOperator = 'eq' | 'ne' | 'contains' | 'not_contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty';
export interface QueryCondition {
  field_id: string;
  operator: QueryOperator;
  value?: string | number | boolean | string[] | null;
}
export interface QueryFilter {
  conjunction: 'and' | 'or';
  conditions: QueryCondition[];
}

const operatorCodes: Record<QueryOperator, number> = {
  eq: 1, ne: 2, contains: 3, not_contains: 4, gt: 5, gte: 6, lt: 7, lte: 8, empty: 9, not_empty: 10,
};
const emptyOperators = new Set<QueryOperator>(['empty', 'not_empty']);
const textOperators = new Set<QueryOperator>(['eq', 'ne', 'contains', 'not_contains', 'empty', 'not_empty']);
const selectOperators = new Set<QueryOperator>(['eq', 'ne', 'contains', 'not_contains', 'empty', 'not_empty']);
const numberOperators = new Set<QueryOperator>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty']);
const dateOperators = new Set<QueryOperator>(['eq', 'ne', 'gt', 'lt', 'empty', 'not_empty']);
const userOperators = new Set<QueryOperator>(['eq', 'ne', 'empty', 'not_empty']);
const checkboxOperators = new Set<QueryOperator>(['eq', 'ne', 'empty', 'not_empty']);
const linkOperators = new Set<QueryOperator>(['eq', 'ne', 'contains', 'not_contains', 'empty', 'not_empty']);

function invalid(message: string): never {
  throw new WecomError('INVALID_ARGUMENT', message);
}

export function querySpec(schema: Schema, filter: QueryFilter) {
  if (!['and', 'or'].includes(filter.conjunction) || !filter.conditions.length || filter.conditions.length > 20) {
    throw new WecomError('INVALID_ARGUMENT', '查询需要 1–20 个条件及 and/or 连接方式。');
  }
  return { conjunction: filter.conjunction === 'and' ? 1 : 2, conditions: filter.conditions.map(condition => {
    const field = schema.fields.find(f => f.id === condition.field_id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '查询条件包含不存在或不可读取的字段 ID。');
    const supported = (set: Set<QueryOperator>) => {
      if (!set.has(condition.operator)) {
        throw new WecomError('UNSUPPORTED_FILTER', `字段类型 ${field.type} 不支持 ${condition.operator} 查询。`, { field_id: field.id });
      }
    };
    const common: Record<string, unknown> = { fieldId: field.id, filterKeyType: field.type_code, operator: operatorCodes[condition.operator] };
    if (emptyOperators.has(condition.operator)) {
      if (condition.value !== undefined && condition.value !== null) invalid('空值查询不能提供查询值。');
      supported(field.type_code === 1 || field.type_code === 8 || field.type_code === 15 || field.type_code === 16
        ? textOperators : field.type_code === 17 || field.type_code === 9 ? selectOperators
          : field.type_code === 2 || field.type_code === 14 ? numberOperators
            : field.type_code === 4 ? dateOperators : field.type_code === 7 ? userOperators
              : field.type_code === 3 ? checkboxOperators : linkOperators);
      return common;
    }
    if (field.type_code === 1) {
      supported(textOperators);
      if (typeof condition.value !== 'string' || !condition.value.length || condition.value.length > 4096) {
        invalid('文本查询值需要 1–4096 字符。');
      }
      if (condition.operator === 'eq' && /[\r\n]/.test(condition.value)) {
        throw new WecomError('UNSUPPORTED_FILTER', '服务端对含换行文本的相等查询与读取值不一致；eq 仅支持单行查询值，请改用 contains。');
      }
      return { ...common, valueText: condition.value };
    }
    if (field.type_code === 8 || field.type_code === 15 || field.type_code === 16) {
      throw new WecomError('UNSUPPORTED_FILTER', '此文本类字段的值查询编码尚未验证；可先用 empty/not_empty 或按整表读取后在本机筛选。', { field_id: field.id, field_type: field.type });
    }
    if (field.type_code === 17) {
      supported(selectOperators);
      if (condition.operator !== 'eq' && condition.operator !== 'ne') {
        throw new WecomError('UNSUPPORTED_FILTER', '单选字段只支持 eq/ne/empty/not_empty 查询。');
      }
      if (typeof condition.value !== 'string') invalid('单选查询值必须是选项 ID。');
      if (!field.options?.some(o => o.id === condition.value)) throw new WecomError('UNKNOWN_OPTION', '单选筛选值必须使用结构返回的已有选项 ID。');
      return { ...common, valueSingleSelect: [condition.value] };
    }
    if (field.type_code === 9) {
      supported(selectOperators);
      if (!Array.isArray(condition.value) || !condition.value.length || condition.value.some(id => typeof id !== 'string')) {
        invalid('多选查询值必须是非空选项 ID 数组。');
      }
      if (condition.value.some(id => !field.options?.some(o => o.id === id))) {
        throw new WecomError('UNKNOWN_OPTION', '多选筛选值必须使用结构返回的已有选项 ID。');
      }
      return { ...common, valueSelects: condition.value };
    }
    if (field.type_code === 7) {
      supported(userOperators);
      if (typeof condition.value !== 'string' || !condition.value) invalid('人员查询值必须是成员 uid。');
      // 真实请求验证：valueUsers 是字符串数组，不是 {values:[{string_value}]}。
      return { ...common, valueUsers: [condition.value] };
    }
    if (field.type_code === 2) {
      supported(numberOperators);
      if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) invalid('数字查询值必须是有限数字。');
      return { ...common, valueNumber: condition.value };
    }
    if (field.type_code === 14) {
      supported(numberOperators);
      if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) invalid('进度查询值必须是有限数字。');
      return { ...common, valueProgress: { number_value: condition.value } };
    }
    if (field.type_code === 4) {
      supported(dateOperators);
      if (typeof condition.value !== 'number' || !Number.isSafeInteger(condition.value)) invalid('日期查询值必须是毫秒时间戳。');
      return { ...common, valueDateTime: { type: 1, timestamps: [condition.value] } };
    }
    if (field.type_code === 3 || field.type_code === 18 || field.type_code === 21) {
      throw new WecomError('UNSUPPORTED_FILTER', '复选框/关联字段的值查询编码尚未验证；empty/not_empty 可用。', { field_id: field.id, field_type: field.type });
    }
    throw new WecomError('UNSUPPORTED_FILTER', '此字段类型尚未验证查询编码。', { field_id: field.id, field_type: field.type });
  }) };
}

export function queryFingerprint(spec: unknown, fields: string[]) {
  return createHash('sha256').update(JSON.stringify({ spec, fields })).digest('hex');
}

function isObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseQueryResult(response: any, sheetId: string, limit: number) {
  requireData(isObject(response) && response.retcode === 0 && isObject(response.result), '筛选查询缺少明确的成功结果。');
  const result = response.result;
  if (result.data_initing) throw new WecomError('DATA_NOT_READY', '查询数据仍在初始化，请稍后重新查询。');
  requireData(result.data_initing === false && Number.isSafeInteger(result.total) && result.total >= 0
    && typeof result.has_more === 'boolean' && typeof result.next_cursor === 'string'
    && typeof result.mutation_json === 'string', '筛选查询的分页结构发生变化。');
  const groups = parseJson(result.mutation_json, '筛选查询记录');
  requireData(Array.isArray(groups) && groups.length === 1 && Array.isArray(groups[0]) && groups[0].length === 1, '筛选查询命令数量发生变化。');
  const command = groups[0][0];
  requireData(command?.t === 3028 && command.v === 5 && command.c?.k1 === sheetId, '筛选查询命令类型、版本或子表不匹配。');
  const delta = command.c.k2 === undefined ? {} : command.c.k2;
  requireData(isObject(delta), '筛选查询记录 delta 无效。');
  const map = delta.k1 === undefined ? {} : delta.k1;
  requireData(isObject(map), '筛选查询记录映射无效。');
  const records = Object.entries(map).map(([id, row]: [string, any]) => {
    requireData(Array.isArray(row?.k2), '筛选查询单元格结构发生变化。');
    const cells: Record<string, any> = Object.create(null);
    for (const cell of row.k2) {
      requireData(isObject(cell) && typeof cell.k100 === 'string' && cell.k100.length > 0
        && !Object.hasOwn(cells, cell.k100), '筛选查询单元格缺少字段 ID 或字段重复。');
      cells[cell.k100] = cell;
    }
    return { id, raw: { k1: cells } };
  });
  requireData(records.length <= limit && records.length <= result.total
    && (result.has_more ? records.length > 0 && result.next_cursor.length > 0 : result.next_cursor === ''), '筛选查询数量或游标不完整。');
  return { records, raw: delta, total: result.total as number, hasMore: result.has_more as boolean, nextCursor: result.next_cursor as string };
}
