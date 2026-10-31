import { createHash } from 'node:crypto';
import { requireData, WecomError } from './errors.js';
import { parseJson, type Schema } from './protocol.js';

export interface QueryFilter {
  conjunction: 'and' | 'or';
  conditions: { field_id: string; operator: 'eq' | 'contains'; value: string }[];
}

export function querySpec(schema: Schema, filter: QueryFilter) {
  if (!['and', 'or'].includes(filter.conjunction) || !filter.conditions.length || filter.conditions.length > 20) {
    throw new WecomError('INVALID_ARGUMENT', '查询需要 1–20 个条件及 and/or 连接方式。');
  }
  return { conjunction: filter.conjunction === 'and' ? 1 : 2, conditions: filter.conditions.map(condition => {
    const field = schema.fields.find(f => f.id === condition.field_id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '查询条件包含不存在或不可读取的字段 ID。');
    if (typeof condition.value !== 'string' || !condition.value.length || condition.value.length > 4096) {
      throw new WecomError('INVALID_ARGUMENT', '筛选值需要 1–4096 字符。');
    }
    const common = { fieldId: field.id, filterKeyType: field.type_code };
    if (field.type_code === 1 && ['eq', 'contains'].includes(condition.operator)) {
      if (condition.operator === 'eq' && /[\r\n]/.test(condition.value)) {
        throw new WecomError('UNSUPPORTED_FILTER', '服务端对含换行文本的相等查询与读取值不一致；目前 eq 仅支持单行查询值，请改用单行关键词 contains。');
      }
      return { ...common, operator: condition.operator === 'eq' ? 1 : 3, valueText: condition.value };
    }
    if (field.type_code === 17 && condition.operator === 'eq') {
      if (!field.options?.some(o => o.id === condition.value)) throw new WecomError('UNKNOWN_OPTION', '单选筛选值必须使用结构返回的已有选项 ID。');
      return { ...common, operator: 1, valueSingleSelect: [condition.value] };
    }
    throw new WecomError('UNSUPPORTED_FILTER', '当前支持 TEXT 的 eq/contains，以及 SINGLE_SELECT 的 eq；其他字段和运算符尚未验证。');
  }) };
}

export function queryFingerprint(spec: unknown, fields: string[]) {
  return createHash('sha256').update(JSON.stringify({ spec, fields })).digest('hex');
}

export function parseQueryResult(response: any, sheetId: string, limit: number) {
  requireData(response.retcode === 0 && response.result, '筛选查询缺少明确的成功结果。');
  const result = response.result;
  if (result.data_initing) throw new WecomError('DATA_NOT_READY', '查询数据仍在初始化，请稍后重新查询。');
  requireData(result.data_initing === false && Number.isSafeInteger(result.total) && result.total >= 0
    && typeof result.has_more === 'boolean' && typeof result.next_cursor === 'string'
    && typeof result.mutation_json === 'string', '筛选查询的分页结构发生变化。');
  const groups = parseJson(result.mutation_json, '筛选查询记录');
  requireData(Array.isArray(groups) && groups.length === 1 && Array.isArray(groups[0]) && groups[0].length === 1, '筛选查询命令数量发生变化。');
  const command = groups[0][0];
  requireData(command?.t === 3028 && command.v === 5 && command.c?.k1 === sheetId, '筛选查询命令类型、版本或子表不匹配。');
  const delta = command.c.k2 || {};
  const map = delta.k1 || {};
  requireData(typeof map === 'object' && !Array.isArray(map), '筛选查询记录映射无效。');
  const records = Object.entries(map).map(([id, row]: [string, any]) => {
    requireData(Array.isArray(row?.k2), '筛选查询单元格结构发生变化。');
    const cells: Record<string, any> = {};
    for (const cell of row.k2) {
      requireData(typeof cell.k100 === 'string' && !Object.hasOwn(cells, cell.k100), '筛选查询单元格缺少字段 ID 或字段重复。');
      cells[cell.k100] = cell;
    }
    return { id, raw: { k1: cells } };
  });
  requireData(records.length <= limit && records.length <= result.total
    && (result.has_more ? records.length > 0 && result.next_cursor.length > 0 : result.next_cursor === ''), '筛选查询数量或游标不完整。');
  return { records, raw: delta, total: result.total as number, hasMore: result.has_more as boolean, nextCursor: result.next_cursor as string };
}
