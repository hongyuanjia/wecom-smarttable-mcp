import { createHash } from 'node:crypto';
import { WecomError } from './errors.js';
import { assertFieldsInViewColumns, assertNoDuplicateFieldIds, extractHiddenFields, compareHiddenFieldSets, compareRequestedWidths,
  compareWidthMaps, mergeWidths, validateCreateFieldSelection, validateHiddenFields, validateUpdateFieldOrder,
  validateWidths } from './view-semantics.js';
import type { NormalizedField } from './fields.js';

type Raw = Record<string, any>;

export type ViewType = 'grid' | 'kanban' | 'gallery' | 'gantt' | 'calendar' | 'form' | string;

const VIEW_TYPES: Record<number, { name: ViewType; verified: boolean }> = {
  1: { name: 'grid', verified: true },
  2: { name: 'kanban', verified: true },
  3: { name: 'gallery', verified: false },
  4: { name: 'gantt', verified: true },
  5: { name: 'calendar', verified: false },
  6: { name: 'form', verified: false },
};

export interface ViewCondition {
  field_id: string;
  field_name: string | null;
  field_type_code: number;
  operator_code: number | null;
  operator: string | null;
  value: unknown;
  dynamic_viewer: boolean;
  semantics: 'inferred' | 'unverified';
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Raw).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface NormalizedView {
  id: string;
  name: string;
  type: ViewType;
  type_code: number;
  type_verified: boolean;
  scope: 'shared' | 'locked' | 'personal';
  editable: boolean | null;
  columns: string[];
  visible_columns: string[];
  hidden_fields: string[];
  absent_fields: string[];
  hidden_fields_source: 'declared' | 'width_flags' | 'absent_from_columns';
  unknown_columns: string[];
  widths: Record<string, number>;
  group: { field_id: string; field_name: string | null; descending: boolean }[];
  sort: { field_id: string; field_name: string | null; descending: boolean }[];
  filter: {
    present: boolean;
    conjunction_code: number | null;
    conjunction: 'and' | 'or' | null;
    conditions: ViewCondition[];
    semantics: 'inferred' | 'unverified';
    comparable: boolean;
  } | null;
  frozen_field_count: number | null;
  statistics_enabled: boolean | null;
  auto_sort: boolean | null;
  kanban: { config: 'parsed' | 'unparsed'; group_field_id: string | null; card_fields: string[] | null; retains_empty_group: boolean | null } | null;
  personal_filter: { present: boolean; condition_count: number | null; digest: string } | null;
  viewer_dependent: boolean;
  dynamic_viewer: { supported: true; reason: string };
  unknown_settings: string[];
  raw_digest: string;
  config_digest: string;
}

function isObject(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldName(fields: Map<string, NormalizedField>, id: unknown) {
  return typeof id === 'string' ? fields.get(id)?.name ?? null : null;
}

function normalizeCondition(condition: Raw, fields: Map<string, NormalizedField>): ViewCondition {
  const type = Number.isInteger(condition.k31) ? condition.k31 : 0;
  const value = condition[String(type)] ?? condition[`k${type}`] ?? null;
  return {
    field_id: typeof condition.k30 === 'string' ? condition.k30 : '',
    field_name: fieldName(fields, condition.k30),
    field_type_code: type,
    operator_code: Number.isInteger(condition.k32) ? condition.k32 : null,
    // 运算符代码语义未经提供方实验确认；只保留代码，不猜成业务运算符。
    operator: null,
    value,
    dynamic_viewer: condition.k35 === true,
    semantics: 'unverified',
  };
}

function personalFilterSummary(filter: unknown) {
  if (filter === null || filter === undefined) return null;
  let count: number | null = null;
  if (isObject(filter)) {
    const candidate = Array.isArray(filter.conditions) ? filter.conditions
      : Array.isArray(filter.k2) ? filter.k2 : null;
    count = candidate ? candidate.length : null;
  }
  return { present: true, condition_count: count,
    digest: createHash('sha256').update(JSON.stringify(filter)).digest('hex') };
}

const KNOWN_VIEW_KEYS = new Set(['k1', 'k30', 'k31', 'k32', 'k33', 'k34', 'k35', 'k37', 'k38']);
const KNOWN_SETTING_KEYS = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k13']);

export function normalizeView(view: Raw, fields: NormalizedField[], personalFilter?: unknown, currentUid?: string | null): NormalizedView {
  const byId = new Map(fields.map(field => [field.id, field]));
  const properties = view[`k${view.k32}`] || {};
  const columns = Array.isArray(properties.k2) ? properties.k2.filter((id: unknown): id is string => typeof id === 'string') : [];
  const widths: Record<string, number> = {};
  if (isObject(properties.k5)) {
    for (const [id, info] of Object.entries(properties.k5)) {
      // 宽度映射可能保留已删除/非本视图字段；只保留当前列，保证摘要跨分块读取稳定。
      if (isObject(info) && typeof info.k1 === 'number' && Number.isFinite(info.k1) && columns.includes(id)) widths[id] = info.k1;
    }
  }
  const filterRaw = properties.k8;
  const conditions = isObject(filterRaw) && Array.isArray(filterRaw.k2) ? filterRaw.k2.map((item: Raw) => normalizeCondition(item, byId)) : [];
  const filter = isObject(filterRaw) && Array.isArray(filterRaw.k2) ? {
    present: true,
    conjunction_code: Number.isInteger(filterRaw.k1) ? filterRaw.k1 : null,
    conjunction: filterRaw.k1 === 2 ? 'or' as const : filterRaw.k1 === 1 || filterRaw.k1 === 0 ? 'and' as const : null,
    conditions,
    semantics: conditions.length ? 'inferred' as const : 'inferred' as const,
    comparable: conditions.length === 0,
  } : null;
  const group = (Array.isArray(properties.k7) ? properties.k7 : []).map((item: Raw) => ({
    field_id: typeof item.k1 === 'string' ? item.k1 : '',
    field_name: fieldName(byId, item.k1),
    descending: Boolean(item.k2),
  }));
  const sort = (Array.isArray(properties.k9) ? properties.k9 : []).map((item: Raw) => ({
    field_id: typeof item.k1 === 'string' ? item.k1 : '',
    field_name: fieldName(byId, item.k1),
    descending: Boolean(item.k2),
  }));
  const type = VIEW_TYPES[view.k32] || { name: `UNVERIFIED_TYPE_${view.k32}`, verified: false };
  const unknownColumns = columns.filter((id: string) => !byId.has(id));
  // k1 显式声明 > k5.k2 宽度标志 > 未出现在当前列；来源集中标记，避免把未知设置当成已验证语义。
  const hidden = extractHiddenFields(view, fields.map(field => field.id));
  const hiddenFields = hidden.hidden_fields;
  const hiddenFieldsSource = hidden.source;
  const visibleColumns = columns.filter((id: string) => !hiddenFields.includes(id));
  const unknownSettings = [
    ...Object.keys(view).filter(key => !KNOWN_VIEW_KEYS.has(key)),
    ...Object.keys(properties).filter(key => !KNOWN_SETTING_KEYS.has(key)),
  ];
  const config = {
    type: type.name, columns, widths, group, sort,
    filter: filter ? { conjunction: filter.conjunction, conditions: filter.conditions.map(item => ({
      field_id: item.field_id, operator: item.operator, value: item.value })) } : null,
    frozen_field_count: typeof properties.k4 === 'number' ? properties.k4 : null, statistics_enabled: typeof properties.k10 === 'boolean' ? properties.k10 : null,
    auto_sort: typeof properties.k6 === 'boolean' ? properties.k6 : null,
  };
  const scope: NormalizedView['scope'] = view.k35 === 3 ? 'personal' : view.k35 === 2 ? 'locked' : 'shared';
  // 锁定视图所有成员都不可改配置；个人视图仅 owner 可改；共享视图按文档权限判断。
  const editable = scope === 'locked' ? false : scope === 'personal'
    ? (currentUid ? view.k34 === currentUid : null) : true;
  return {
    id: view.k30,
    name: view.k31,
    type: type.name,
    type_code: view.k32,
    type_verified: type.verified,
    scope,
    editable,
    columns,
    visible_columns: visibleColumns,
    hidden_fields: hiddenFields,
    absent_fields: hidden.absent_fields,
    hidden_fields_source: hiddenFieldsSource,
    unknown_columns: unknownColumns,
    widths,
    group,
    sort,
    filter,
    frozen_field_count: typeof properties.k4 === 'number' ? properties.k4 : null,
    statistics_enabled: config.statistics_enabled,
    auto_sort: config.auto_sort,
    kanban: view.k32 === 2 ? { config: 'parsed', group_field_id: group[0]?.field_id ?? null, card_fields: visibleColumns, retains_empty_group: true } : null,
    personal_filter: personalFilterSummary(personalFilter),
    viewer_dependent: conditions.some(condition => condition.dynamic_viewer),
    dynamic_viewer: { supported: true,
      reason: '动态“我”使用 k35=true 表达；已用真实视图创建验证。' },
    unknown_settings: [...new Set(unknownSettings)].sort(),
    raw_digest: createHash('sha256').update(stableStringify(view)).digest('hex'),
    config_digest: createHash('sha256').update(stableStringify(config)).digest('hex'),
  };
}

export function normalizeViews(rawViews: Raw[], fields: NormalizedField[], personalFilters: Record<string, unknown> = {},
  currentUid?: string | null): NormalizedView[] {
  return rawViews.map(view => normalizeView(view, fields, personalFilters[view.k30], currentUid));
}

export interface ViewConditionInput {
  field_id: string;
  operator: 'eq' | 'ne' | 'contains' | 'not_contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty';
  value?: string | number | boolean | null;
  value_kind?: 'literal' | 'current_viewer';
}

export interface ViewFilterInput {
  conjunction: 'and' | 'or';
  conditions: ViewConditionInput[];
}

export interface ViewWriteInput {
  name?: string;
  type?: ViewType;
  scope?: 'shared' | 'locked' | 'personal';
  expected_view_digest?: string;
  filter?: ViewFilterInput | null;
  group?: { field_id: string; descending?: boolean }[];
  sort?: { field_id: string; descending?: boolean }[];
  hidden_fields?: string[];
  field_order?: string[];
  widths?: Record<string, number>;
  frozen_field_count?: number | null;
  statistics?: boolean | null;
  kanban?: { group_field_id: string; card_fields: string[]; retains_empty_group: true };
}

export interface ViewWritePlan {
  action: 'create' | 'update';
  decision: 'create' | 'update' | 'skip' | 'conflict';
  view_id: string | null;
  name: string;
  differences: { path: string; before: unknown; after: unknown }[];
  effective: Record<string, unknown>;
  preserves_unknown_settings: true;
  requires_provider_capability: 'view.create' | 'view.update';
  comparable: boolean;
  notes: string[];
}

function compare(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

const placement = (items: { field_id: string; descending?: boolean }[]) =>
  items.map(item => ({ field_id: item.field_id, descending: Boolean(item.descending) }));

function validateConditionInput(condition: ViewConditionInput, fields: Map<string, NormalizedField>, index: number) {
  const field = fields.get(condition.field_id);
  if (!field) throw new WecomError('UNKNOWN_FIELD', `筛选条件 ${index + 1} 引用了不存在或不可读取的字段。`, { field_id: condition.field_id });
  if (condition.value_kind === 'current_viewer') {
    if (field.type_code !== 7) throw new WecomError('INVALID_ARGUMENT', '动态“我”只能用于人员字段。', { field_id: field.id, index });
    return;
  }
  if (['empty', 'not_empty'].includes(condition.operator)) {
    if (condition.value !== undefined && condition.value !== null) {
      throw new WecomError('INVALID_ARGUMENT', '空值条件不能同时提供筛选值。', { index });
    }
    return;
  }
  if (condition.value === undefined || condition.value === null || condition.value === '') {
    throw new WecomError('INVALID_ARGUMENT', '非空值条件需要提供筛选值。', { index });
  }
  if (typeof condition.value === 'object') throw new WecomError('INVALID_ARGUMENT', '筛选值必须是文本、数字或布尔值。', { index });
}

function validateFieldList(ids: string[], fields: Map<string, NormalizedField>, label: string, max: number) {
  if (!Array.isArray(ids) || ids.length > max) throw new WecomError('INVALID_ARGUMENT', `${label}数量无效。`);
  assertNoDuplicateFieldIds(ids, label);
  for (const id of ids) if (!fields.has(id)) throw new WecomError('UNKNOWN_FIELD', `${label}包含不存在或不可读取的字段。`, { field_id: id });
}

function comparableFilter(filter: NormalizedView['filter']) {
  // 空 conditions 与未设置筛选语义相同：服务端会把清除后的筛选保留为 {conjunction, conditions: []}。
  if (!filter || !filter.conditions.length) return null;
  return {
    conjunction: filter.conjunction,
    conditions: filter.conditions.map(condition => ({
      field_id: condition.field_id,
      operator_code: condition.operator_code,
      value: condition.value,
      dynamic_viewer: condition.dynamic_viewer,
    })),
  };
}

function normalizedConfigDifferences(existing: NormalizedView, expected: NormalizedView) {
  const differences: { path: string; before: unknown; after: unknown }[] = [];
  const push = (path: string, before: unknown, after: unknown) => {
    if (!compare(before, after)) differences.push({ path, before, after });
  };
  push('type', existing.type, expected.type);
  push('scope', existing.scope, expected.scope);
  push('columns', existing.columns, expected.columns);
  differences.push(...compareHiddenFieldSets(existing.hidden_fields, expected.hidden_fields));
  differences.push(...compareWidthMaps(existing.widths, expected.widths));
  push('group', placement(existing.group), placement(expected.group));
  push('sort', placement(existing.sort), placement(expected.sort));
  push('filter', comparableFilter(existing.filter), comparableFilter(expected.filter));
  push('frozen_field_count', existing.frozen_field_count, expected.frozen_field_count);
  push('statistics', existing.statistics_enabled, expected.statistics_enabled);
  push('auto_sort', existing.auto_sort, expected.auto_sort);
  return differences;
}

export interface CreateViewComparison {
  decision: 'skip' | 'conflict';
  view_id: string;
  name: string;
  differences: { path: string; before: unknown; after: unknown }[];
}

function rawViewFromBuilt(built: Raw): Raw {
  const properties = built['1'] || {};
  const condition = (item: Raw) => {
    const type = item['31'];
    const mapped: Raw = { k30: item['30'], k31: type, k32: item['32'], k33: item['33'], k35: item['35'] };
    if (item[String(type)] !== undefined) mapped[`k${type}`] = item[String(type)];
    return mapped;
  };
  const rawPlacement = (items: Raw[] | undefined) => (items || []).map(item => ({ k1: item['1'], k2: item['2'] }));
  return {
    k30: built['30'], k31: built['31'], k32: built['32'], k33: built['33'], k34: built['34'], k35: built['35'],
    k1: {
      k1: properties['1'], k2: properties['2'], k3: properties['3'], k4: properties['4'],
      k5: Object.fromEntries(Object.entries(properties['5'] || {}).map(([id, info]: [string, any]) =>
        [id, { k1: info['1'], k2: info['2'] }])),
      k6: properties['6'],
      k7: rawPlacement(properties['7']),
      k8: properties['8'] ? { k1: properties['8']['1'], k2: (properties['8']['2'] || []).map(condition) } : null,
      k9: rawPlacement(properties['9']),
      k10: properties['10'],
    },
  };
}

// 直接创建与计划工具共用同名比较：用相同默认值生成“将要创建”的规范化配置，再与已有视图逐项比较。
export function compareCreateView(input: {
  patch: ViewWriteInput;
  views: NormalizedView[];
  fields: NormalizedField[];
}): CreateViewComparison | null {
  const name = input.patch.name;
  if (!name) throw new WecomError('INVALID_ARGUMENT', '新建视图需要名称。');
  const sameName = input.views.filter(view => view.name === name);
  if (sameName.length > 1) throw new WecomError('VIEW_AMBIGUOUS', '存在多个同名视图，必须用 view_id 定位后再修改。', {
    name, view_ids: sameName.map(view => view.id) });
  if (!sameName.length) return null;
  const expected = normalizeView(rawViewFromBuilt(buildViewObject({
    viewId: 'v_create_compare', name, type: input.patch.type || 'grid', actorUid: 'local_compare',
    recordIds: [], fields: input.fields, patch: input.patch,
  })), input.fields);
  const differences = normalizedConfigDifferences(sameName[0], expected);
  return { decision: differences.length ? 'conflict' : 'skip', view_id: sameName[0].id, name, differences };
}

export function planViewWrite(input: {
  action: 'create' | 'update';
  view_id?: string;
  patch: ViewWriteInput;
  views: NormalizedView[];
  fields: NormalizedField[];
}): ViewWritePlan {
  const byId = new Map(input.fields.map(field => [field.id, field]));
  const patch = input.patch;
  const existing = input.action === 'update'
    ? input.views.find(view => view.id === input.view_id)
    : undefined;
  if (input.action === 'update' && !existing) {
    throw new WecomError('UNKNOWN_VIEW', 'view_id 不存在或不可读取。', { view_id: input.view_id });
  }
  if (input.action === 'create' && input.view_id !== undefined) {
    throw new WecomError('INVALID_ARGUMENT', '新建视图不能同时指定 view_id。');
  }
  if (input.action === 'update' && patch.type !== undefined && patch.type !== existing!.type) {
    throw new WecomError('UNSUPPORTED_VIEW_CHANGE', '不支持修改视图类型；需要先新建目标类型视图，不能直接转换。');
  }
  const name = patch.name ?? existing?.name;
  if (!name) throw new WecomError('INVALID_ARGUMENT', '视图需要名称。');

  // 同名创建比较也会读取补丁；集合/宽度校验必须先于任何比较执行，避免重复 ID 或非法宽度被静默折叠。
  const tableFieldIds = input.fields.map(field => field.id);
  if (patch.hidden_fields !== undefined) validateHiddenFields(patch.hidden_fields, tableFieldIds);
  if (patch.widths !== undefined) validateWidths(patch.widths, tableFieldIds);

  // 更新时重命名为另一个已存在的视图名同样需要先确认，不能静默制造同名视图。
  if (input.action === 'update' && existing && name !== existing.name) {
    const sameName = input.views.filter(view => view.id !== existing.id && view.name === name);
    if (sameName.length > 1) throw new WecomError('VIEW_AMBIGUOUS', '目标名称对应多个已有视图，必须用 view_id 定位。', {
      name, view_ids: sameName.map(view => view.id) });
    if (sameName.length === 1) {
      return { action: 'update', decision: 'conflict', view_id: existing.id, name,
        differences: [{ path: 'name', before: existing.name, after: name }],
        effective: {}, preserves_unknown_settings: true, requires_provider_capability: 'view.update', comparable: false,
        notes: [`名称已被视图 ${sameName[0].id} 使用；需先确认是否重命名或改用 view_id。`] };
    }
  }

  // 同名视图处理：唯一且配置相同则跳过，配置不同先给差异，多个同名必须用 ID 定位。
  if (input.action === 'create') {
    const comparison = compareCreateView({ patch, views: input.views, fields: input.fields });
    if (comparison) {
      return { action: 'create', decision: comparison.decision, view_id: comparison.view_id, name,
        differences: comparison.differences,
        effective: {}, preserves_unknown_settings: true, requires_provider_capability: 'view.create',
        comparable: comparison.decision === 'skip',
        notes: comparison.decision === 'skip'
          ? ['同名视图的规范化配置与本次创建请求一致；直接创建应返回已有视图且不写入。']
          : ['同名视图的规范化配置与本次创建请求不同；必须改用 view_id 更新，不能静默覆盖。'] };
    }
  }

  const effective: Record<string, unknown> = {
    name, type: patch.type ?? existing?.type,
    filter: patch.filter === undefined ? (existing?.filter ? { present: true } : null) : patch.filter,
  };
  if (patch.filter === null) effective.filter = null;
  if (patch.filter) {
    if (!patch.filter.conditions.length) throw new WecomError('INVALID_ARGUMENT', '清除筛选请显式传 filter: null；空 conditions 不会被解释为清空。');
    if (patch.filter.conditions.length > 20) throw new WecomError('INVALID_ARGUMENT', '筛选条件最多 20 条。');
    patch.filter.conditions.forEach((condition, index) => validateConditionInput(condition, byId, index));
    effective.filter = { conjunction: patch.filter.conjunction, conditions: patch.filter.conditions };
  }
  if (patch.group !== undefined) {
    validateFieldList(patch.group.map(item => item.field_id), byId, '分组字段', 3);
    effective.group = patch.group.map(item => ({ field_id: item.field_id, descending: Boolean(item.descending) }));
  } else effective.group = existing?.group.map(item => ({ field_id: item.field_id, descending: item.descending })) ?? [];
  if (patch.sort !== undefined) {
    validateFieldList(patch.sort.map(item => item.field_id), byId, '排序字段', 5);
    effective.sort = patch.sort.map(item => ({ field_id: item.field_id, descending: Boolean(item.descending) }));
  } else effective.sort = existing?.sort.map(item => ({ field_id: item.field_id, descending: item.descending })) ?? [];

  if (patch.field_order !== undefined) {
    // 更新与新建是两套契约：更新只能重排当前视图列，新建可以选择全表字段的子集。
    effective.columns = input.action === 'update'
      ? validateUpdateFieldOrder(patch.field_order, {
        current_columns: existing!.columns,
        table_field_ids: input.fields.map(field => field.id),
        view_id: existing!.id,
      })
      : validateCreateFieldSelection(patch.field_order, input.fields.map(field => field.id));
  } else effective.columns = existing?.columns ?? input.fields.map(field => field.id);
  if (patch.hidden_fields !== undefined) {
    assertFieldsInViewColumns(patch.hidden_fields, effective.columns as string[],
      'hidden_fields 只能设置当前视图列内的字段；未加入视图的字段不能通过隐藏列显示或隐藏。',
      { view_id: existing?.id });
    effective.hidden_fields = patch.hidden_fields;
  } else effective.hidden_fields = existing?.hidden_fields ?? [];
  if (patch.widths !== undefined) {
    // 局部补丁：未提交的列宽保持现状，避免把整段宽度字典当作替换目标。
    // 宽度键同样必须属于有效视图列；全表字段没有可调整的列宽。
    assertFieldsInViewColumns(Object.keys(patch.widths), effective.columns as string[],
      'widths 只能设置当前视图列内的字段；未加入视图的字段没有可调整的列宽。',
      { view_id: existing?.id });
    effective.widths = mergeWidths(existing?.widths ?? {}, patch.widths);
  } else effective.widths = existing?.widths ?? {};
  if (patch.frozen_field_count !== undefined) {
    if (patch.frozen_field_count !== null && (!Number.isInteger(patch.frozen_field_count) || patch.frozen_field_count < 0 || patch.frozen_field_count > input.fields.length)) {
      throw new WecomError('INVALID_ARGUMENT', '冻结列数量超出字段范围。');
    }
    effective.frozen_field_count = patch.frozen_field_count;
  } else effective.frozen_field_count = existing?.frozen_field_count ?? null;
  // k10 只有布尔状态；null 不能写回，统一解释为关闭，避免计划与实际写入语义分叉。
  if (patch.statistics !== undefined) effective.statistics = patch.statistics === null ? false : patch.statistics;
  else effective.statistics = existing?.statistics_enabled ?? null;
  if (patch.kanban !== undefined) {
    if (patch.kanban.retains_empty_group !== true) {
      throw new WecomError('INVALID_ARGUMENT', '看板必须保留未填状态记录（retains_empty_group: true）。');
    }
    validateFieldList([patch.kanban.group_field_id], byId, '看板分组字段', 1);
    validateFieldList(patch.kanban.card_fields, byId, '看板卡片字段', 20);
    effective.kanban = patch.kanban;
  } else effective.kanban = existing?.kanban ?? null;

  const differences: { path: string; before: unknown; after: unknown }[] = [];
  const comparableFilters = patch.filter === undefined || patch.filter === null || existing?.filter?.comparable === true;
  if (existing) {
    if (existing.name !== name) differences.push({ path: 'name', before: existing.name, after: name });
    if (!compare(existing.columns, effective.columns)) differences.push({ path: 'columns', before: existing.columns, after: effective.columns });
    differences.push(...compareHiddenFieldSets(existing.hidden_fields, effective.hidden_fields as string[]));
    // 只核验本次请求的列宽键；未请求键由 mergeWidths 保留，不作为差异。
    if (patch.widths !== undefined) differences.push(...compareRequestedWidths(existing.widths, patch.widths));
    if (!compare(placement(existing.group), placement(effective.group as any))) differences.push({ path: 'group', before: existing.group, after: effective.group });
    if (!compare(placement(existing.sort), placement(effective.sort as any))) differences.push({ path: 'sort', before: existing.sort, after: effective.sort });
    if (patch.filter === null && existing.filter) differences.push({ path: 'filter', before: 'present', after: null });
    else if (patch.filter && !comparableFilters) differences.push({ path: 'filter', before: 'unverified_raw', after: effective.filter });
    if (patch.kanban !== undefined && !compare(existing.kanban, effective.kanban)) {
      differences.push({ path: 'kanban', before: existing.kanban, after: effective.kanban });
    }
    if (patch.frozen_field_count !== undefined && existing.frozen_field_count !== effective.frozen_field_count) {
      differences.push({ path: 'frozen_field_count', before: existing.frozen_field_count, after: effective.frozen_field_count });
    }
    if (patch.statistics !== undefined && existing.statistics_enabled !== effective.statistics) {
      differences.push({ path: 'statistics', before: existing.statistics_enabled, after: effective.statistics });
    }
  } else {
    for (const [path, after] of Object.entries(effective)) if (after !== null && after !== undefined) differences.push({ path, before: undefined, after });
  }
  const decision = input.action === 'create' ? 'create' : differences.length ? 'update' : 'skip';
  return {
    action: input.action,
    decision,
    view_id: existing?.id ?? null,
    name,
    differences,
    effective,
    preserves_unknown_settings: true,
    requires_provider_capability: input.action === 'create' ? 'view.create' : 'view.update',
    comparable: comparableFilters,
    notes: [
      '补丁未提交；本结果只做本地差异与契约检查，实际写入由 wecom_create_view / wecom_update_view 执行。',
      ...(comparableFilters ? [] : ['现有筛选运算符代码不在已验证集合内，无法自动判定配置是否完全相同。']),
      '未识别的原有视图设置按局部补丁保留，不覆盖整个视图对象。',
    ],
  };
}

export const VIEW_TYPE_CODES: Record<string, number> = {
  grid: 1, kanban: 2, gallery: 3, gantt: 4, calendar: 5, form: 6,
};

export function encodeViewGroup(items: { field_id: string; descending?: boolean }[]): Raw[] {
  return items.map(item => ({ '1': item.field_id, '2': Boolean(item.descending) }));
}

// 3025 c.3：k10 是“字段统计启用”标志，不是底部统计行显隐；null 视为关闭。
export function encodeViewStatistics(enabled: boolean | null): Raw {
  return { '1': enabled === true };
}

// 3025 的回读只核对 k1.k10；同一次调用中的其他步骤各自核对，不能拿整体 config_digest 比较。
export function viewStatisticsMatches(rawView: Raw, enabled: boolean): boolean {
  return rawView[`k${rawView.k32}`]?.k10 === enabled;
}

export function encodeViewSort(items: { field_id: string; descending?: boolean }[]): Raw[] {
  return items.map(item => ({ '1': item.field_id, '2': Boolean(item.descending) }));
}

// 视图筛选条件编码来自真实网页请求：文本 1=值；单选 17=[选项ID]；人员动态“我”用 k35=true。
export function encodeViewFilter(filter: ViewFilterInput | null, fields: NormalizedField[]): Raw | null {
  if (filter === null) return null;
  if (!filter.conditions.length) throw new WecomError('INVALID_ARGUMENT', '清除视图筛选请传 filter: null；空 conditions 不会被当作清空。');
  const byId = new Map(fields.map(field => [field.id, field]));
  const conjunction = filter.conjunction === 'or' ? 2 : 1;
  const conditions = filter.conditions.map((condition, index) => {
    const field = byId.get(condition.field_id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '视图筛选引用了不存在或不可读取的字段。', { field_id: condition.field_id, index });
    if (condition.value_kind === 'current_viewer') {
      if (field.type_code !== 7) throw new WecomError('INVALID_ARGUMENT', '动态“我”只能用于人员字段。', { field_id: field.id, index });
      return { '30': field.id, '31': 7, '32': condition.operator === 'eq' ? 1 : 3, '33': 0, '35': true };
    }
    if (!['eq', 'contains'].includes(condition.operator)) {
      throw new WecomError('UNSUPPORTED_FILTER', '视图筛选当前只验证了 eq/contains；其他运算符尚未写入。', { field_id: field.id, operator: condition.operator });
    }
    const operatorCode = condition.operator === 'eq' ? 1 : 3;
    if (field.type_code === 1) {
      if (typeof condition.value !== 'string') throw new WecomError('INVALID_ARGUMENT', '文本筛选值必须是字符串。', { field_id: field.id });
      return { '1': condition.value, '30': field.id, '31': 1, '32': operatorCode, '33': 0, '35': false };
    }
    if (field.type_code === 17) {
      if (typeof condition.value !== 'string' || !field.options?.some(option => option.id === condition.value)) {
        throw new WecomError('UNKNOWN_OPTION', '单选筛选值必须使用结构返回的已有选项 ID。', { field_id: field.id });
      }
      return { '17': [condition.value], '30': field.id, '31': 17, '32': operatorCode, '33': 0, '35': false };
    }
    throw new WecomError('UNSUPPORTED_FILTER', '此字段类型或筛选值尚未验证；未生成视图写入。', { field_id: field.id, field_type: field.type });
  });
  return { '1': conjunction, '2': conditions };
}

export function buildViewObject(input: {
  viewId: string; name: string; type: ViewType; actorUid: string;
  recordIds: string[]; fields: NormalizedField[]; patch: ViewWriteInput;
}): Raw {
  const typeCode = VIEW_TYPE_CODES[input.type];
  if (!typeCode) throw new WecomError('UNSUPPORTED_VIEW_TYPE', '不支持的视图类型。', { type: input.type });
  const fieldIds = input.fields.map(field => field.id);
  // 直接创建视图与更新共用同一套隐藏列/列宽校验；重复 ID 不能被 Set 静默折叠。
  validateHiddenFields(input.patch.hidden_fields || [], fieldIds);
  validateWidths(input.patch.widths || {}, fieldIds);
  const hidden = new Set(input.patch.hidden_fields || []);
  // 新建视图使用独立的字段选择契约：允许选择全表字段的子集，但不允许重复或混入其他表字段。
  const requested = validateCreateFieldSelection(input.patch.field_order || fieldIds, fieldIds);
  if (input.type !== 'kanban') {
    assertFieldsInViewColumns([...hidden], requested,
      '新建视图的 hidden_fields 只能包含在本次选择的列中；未选择的字段不是隐藏列。',
      { code: 'INVALID_ARGUMENT' });
  }
  const columns = (input.type === 'kanban' && input.patch.kanban
    ? input.patch.kanban.card_fields
    : requested.filter(id => !hidden.has(id)));
  if (!columns.length) throw new WecomError('INVALID_ARGUMENT', '视图至少需要一列。');
  const widths = Object.fromEntries(columns.map(id => [id, input.patch.widths?.[id] ?? 140]));
  const group = input.type === 'kanban' && input.patch.kanban
    ? [{ '1': input.patch.kanban.group_field_id, '2': false }]
    : encodeViewGroup(input.patch.group || []);
  return {
    '1': {
      '1': input.recordIds, '2': columns, '3': 1, '4': 1,
      '5': Object.fromEntries(columns.map(id => [id, { '1': widths[id], '2': false }])),
      '6': true, '7': group, '8': encodeViewFilter(input.patch.filter ?? null, input.fields),
      '9': encodeViewSort(input.patch.sort || []), '10': input.patch.statistics === true,
      '11': { '1': 0, '2': '', '3': '', '4': '', '5': true, '6': 2, '7': [], '8': [] },
      '12': null,
    },
    '30': input.viewId, '31': input.name, '32': typeCode, '33': 2, '34': input.actorUid,
    '35': input.patch.scope === 'personal' ? 3 : input.patch.scope === 'locked' ? 2 : 1, '36': null, '37': [], '38': {},
  };
}
