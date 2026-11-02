import { WecomError } from './errors.js';

export interface ViewSemanticDifference {
  path: string;
  before: unknown;
  after: unknown;
}

// 隐藏列、列宽等集合/补丁语义只在这里定义，计划、执行回读和独立核验共用。
export function sameFieldSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every(value => b.has(value));
}

export function assertNoDuplicateFieldIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new WecomError('INVALID_ARGUMENT', `${label}包含重复字段。`);
}

// actual 为回读现状，expected 为目标；顺序不产生差异，只报告缺少/多出的具体字段。
export function compareHiddenFieldSets(actual: readonly string[], expected: readonly string[]): ViewSemanticDifference[] {
  if (sameFieldSet(actual, expected)) return [];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const differences: ViewSemanticDifference[] = [];
  for (const id of [...expectedSet].sort()) {
    if (!actualSet.has(id)) differences.push({ path: `hidden_fields.missing.${id}`, before: false, after: true });
  }
  for (const id of [...actualSet].sort()) {
    if (!expectedSet.has(id)) differences.push({ path: `hidden_fields.extra.${id}`, before: true, after: false });
  }
  return differences;
}

// 列宽补丁是局部更新：有效目标 = 现有宽度 + patch，未请求键保留。
export function mergeWidths(existing: Record<string, number>, patch: Record<string, number>): Record<string, number> {
  return { ...existing, ...patch };
}

// 仅核验本次请求的键；差异路径精确到 widths.<field_id>。
export function compareRequestedWidths(actual: Record<string, number>, requested: Record<string, number>): ViewSemanticDifference[] {
  return Object.keys(requested).sort().flatMap(id => actual[id] === requested[id] ? []
    : [{ path: `widths.${id}`, before: actual[id], after: requested[id] }]);
}

// 未请求键属于受保护配置：回读前后必须保持原值，不能被局部写入顺带重置。
export function compareProtectedWidths(before: Record<string, number>, after: Record<string, number>,
  requested: readonly string[]): ViewSemanticDifference[] {
  const requestedSet = new Set(requested);
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => !requestedSet.has(id)).sort();
  return ids.flatMap(id => before[id] === after[id] ? []
    : [{ path: `widths.${id}`, before: before[id], after: after[id] }]);
}

// 完整目标字典（例如新建视图）也使用同一路径格式，不返回整段大对象。
export function compareWidthMaps(actual: Record<string, number>, expected: Record<string, number>): ViewSemanticDifference[] {
  const ids = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return ids.flatMap(id => actual[id] === expected[id] ? []
    : [{ path: `widths.${id}`, before: actual[id], after: expected[id] }]);
}

export interface UpdateFieldOrderContext {
  current_columns: readonly string[];
  table_field_ids: readonly string[];
  view_id?: string;
}

// 更新已有视图：field_order 只表示当前视图全部列（含隐藏列）的排列，只允许换序。
// 计划、执行回读和核验共用这一入口，不能按全表字段数补齐，也不能借更新增删视图列。
export function validateUpdateFieldOrder(fieldOrder: readonly string[], context: UpdateFieldOrderContext): string[] {
  assertNoDuplicateFieldIds(fieldOrder, '列顺序');
  const tableFields = new Set(context.table_field_ids);
  for (const id of fieldOrder) {
    if (!tableFields.has(id)) throw new WecomError('UNKNOWN_FIELD',
      '列顺序包含不属于目标表的字段；更新已有视图不能加入其他表字段。', {
        view_id: context.view_id, field_id: id, field_scope: 'target_table' });
  }
  const unknownCurrent = context.current_columns.filter(id => !tableFields.has(id));
  if (unknownCurrent.length) throw new WecomError('UNSUPPORTED_VIEW_CHANGE',
    '当前视图包含目标表中不存在的列，无法安全调整顺序。', {
      view_id: context.view_id, unknown_columns: unknownCurrent,
      current_columns: [...context.current_columns] });
  const current = new Set(context.current_columns);
  const requested = new Set(fieldOrder);
  const extra = fieldOrder.filter(id => !current.has(id));
  const missing = context.current_columns.filter(id => !requested.has(id));
  if (extra.length || missing.length || fieldOrder.length !== context.current_columns.length) {
    throw new WecomError('INVALID_ARGUMENT',
      '更新已有视图时，列顺序必须恰好包含当前视图全部列（含隐藏列）的排列，不能增删或替换列。', {
        view_id: context.view_id,
        current_columns: [...context.current_columns],
        current_column_count: context.current_columns.length,
        submitted_column_count: fieldOrder.length,
        extra_columns: extra,
        missing_columns: missing,
      });
  }
  return [...fieldOrder];
}

// 新建视图：field_order 表示新视图要包含的列，可以选择全表字段的子集；
// 与更新契约分开，避免把新建的字段选择误当成已有视图的成员替换。
export function validateCreateFieldSelection(fieldIds: readonly string[], tableFieldIds: readonly string[]): string[] {
  assertNoDuplicateFieldIds(fieldIds, '列顺序');
  if (!fieldIds.length) throw new WecomError('INVALID_ARGUMENT', '新建视图至少需要选择一列。');
  const tableFields = new Set(tableFieldIds);
  for (const id of fieldIds) {
    if (!tableFields.has(id)) throw new WecomError('UNKNOWN_FIELD',
      '列顺序包含不属于目标表的字段。', { field_id: id, field_scope: 'target_table' });
  }
  return [...fieldIds];
}
