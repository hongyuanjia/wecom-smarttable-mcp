import { WecomError } from './errors.js';

type Raw = Record<string, any>;

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

export function validateHiddenFields(ids: readonly string[], fieldIds: readonly string[], label = '隐藏列'): string[] {
  assertNoDuplicateFieldIds(ids, label);
  const known = new Set(fieldIds);
  for (const id of ids) {
    if (!known.has(id)) throw new WecomError('UNKNOWN_FIELD', `${label}包含不存在或不可读取的字段。`, { field_id: id });
  }
  return [...ids];
}

export function validateWidths(widths: Record<string, number>, fieldIds: readonly string[]): Record<string, number> {
  const known = new Set(fieldIds);
  for (const [id, width] of Object.entries(widths)) {
    if (!known.has(id)) throw new WecomError('UNKNOWN_FIELD', '列宽设置包含不存在或不可读取的字段。', { field_id: id });
    if (!Number.isInteger(width) || width < 1 || width > 1000) {
      throw new WecomError('INVALID_ARGUMENT', '列宽必须是 1–1000 的整数。', { field_id: id, width });
    }
  }
  return widths;
}

// 视图列成员校验：hidden_fields 与 widths 只能指向当前有效视图列（含隐藏列）。
// 全表存在但未加入视图的字段不是可显示/隐藏的列，也没有可调整的列宽。
export function assertFieldsInViewColumns(fieldIds: readonly string[], columns: readonly string[],
  message: string, options: { code?: string; view_id?: string } = {}): string[] {
  const columnSet = new Set(columns);
  const outside = fieldIds.filter(id => !columnSet.has(id));
  if (outside.length) {
    throw new WecomError(options.code ?? 'UNSUPPORTED_VIEW_CHANGE', message, {
      ...(options.view_id !== undefined ? { view_id: options.view_id } : {}),
      field_ids: outside,
    });
  }
  return [...fieldIds];
}

// 隐藏列来源优先级：k1 显式声明 > k5.k2 宽度标志 > 未出现在当前视图列中。
// 计划、执行回读和核验必须从同一入口读取，否则同一视图会得到不同隐藏集合。
export interface HiddenFieldExtraction {
  hidden_fields: string[];
  absent_fields: string[];
  source: 'declared' | 'width_flags' | 'absent_from_columns';
}

export function extractHiddenFields(view: Raw, fieldIds: readonly string[]): HiddenFieldExtraction {
  const properties = view[`k${view.k32}`] || {};
  const known = new Set(fieldIds);
  const columns = Array.isArray(properties.k2)
    ? properties.k2.filter((id: unknown): id is string => typeof id === 'string') : [];
  const columnSet = new Set(columns);
  const absent_fields = fieldIds.filter(id => !columnSet.has(id));
  const declared = Array.isArray(properties.k1)
    ? properties.k1.filter((id: unknown): id is string => typeof id === 'string' && known.has(id) && columnSet.has(id)) : [];
  if (declared.length) return { hidden_fields: declared, absent_fields, source: 'declared' };
  const widthFlags: string[] = [];
  if (properties.k5 && typeof properties.k5 === 'object') {
    for (const [id, info] of Object.entries(properties.k5)) {
      if (info && typeof info === 'object' && (info as Raw).k2 === true && known.has(id) && columnSet.has(id)) widthFlags.push(id);
    }
  }
  if (widthFlags.length) return { hidden_fields: widthFlags, absent_fields, source: 'width_flags' };
  // 未加入视图的字段不是“可显示/隐藏”的列，不能混入 hidden_fields。
  return { hidden_fields: [], absent_fields, source: 'absent_from_columns' };
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

function widthDifferences(ids: readonly string[], before: Record<string, number>,
  after: Record<string, number>): ViewSemanticDifference[] {
  return ids.flatMap(id => before[id] === after[id] ? []
    : [{ path: `widths.${id}`, before: before[id], after: after[id] }]);
}

// 仅核验本次请求的键；差异路径精确到 widths.<field_id>。
export function compareRequestedWidths(actual: Record<string, number>, requested: Record<string, number>): ViewSemanticDifference[] {
  return widthDifferences(Object.keys(requested).sort(), actual, requested);
}

// 未请求键属于受保护配置：回读前后必须保持原值，不能被局部写入顺带重置。
export function compareProtectedWidths(before: Record<string, number>, after: Record<string, number>,
  requested: readonly string[]): ViewSemanticDifference[] {
  const requestedSet = new Set(requested);
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => !requestedSet.has(id)).sort();
  return widthDifferences(ids, before, after);
}

// 完整目标字典（例如新建视图）也使用同一路径格式，不返回整段大对象。
export function compareWidthMaps(actual: Record<string, number>, expected: Record<string, number>): ViewSemanticDifference[] {
  const ids = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return widthDifferences(ids, actual, expected);
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
