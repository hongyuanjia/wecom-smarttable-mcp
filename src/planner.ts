import { createHash } from 'node:crypto';
import { WecomError } from './errors.js';
import { affectedDependents, dependencyCycles, userFieldMultiple, type NormalizedField } from './fields.js';
import { capabilityById } from './capabilities.js';
import { planViewWrite, type NormalizedView, type ViewWriteInput } from './views.js';
import { compareMemberCell, memberFieldMultiple, planMemberUpdates, type MemberCell, type MemberUpdateInput } from './members.js';
import { validateFormulaDefinition, PROVIDER_FORMULA_CALLS, type FormulaDefinition, type FormulaExpression } from './formulas.js';

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface PlanSheet {
  id: string;
  name: string;
  revision: number;
  total_records_in_table: number;
  fields: NormalizedField[];
  views: NormalizedView[];
  record_ids?: string[];
  member_cells?: Record<string, Record<string, MemberCell>>;
}

export interface PlanContext {
  document_id: string;
  title?: string;
  sheets: PlanSheet[];
}

export type PlanChange =
  | { kind: 'member_cells'; sheet_id: string; field_id?: string; notify_members: boolean; updates: MemberUpdateInput[] }
  | { kind: 'view'; action: 'create' | 'update'; sheet_id: string; view_id?: string; patch: ViewWriteInput }
  | { kind: 'field_update'; sheet_id: string; field_id: string; patch: { name?: string; user_multiple?: boolean; user_notify?: boolean } }
  | { kind: 'lookup_field'; sheet_id: string; name: string; lookup: Record<string, unknown> }
  | { kind: 'relation_field'; sheet_id: string; name: string; relation: { target_sheet_id: string; multiple: boolean; two_way?: boolean } }
  | { kind: 'relation_cells'; sheet_id: string; field_id: string; updates: { record_id: string; target_record_ids: string[] }[] }
  | { kind: 'formula_field'; action: 'create' | 'update'; sheet_id: string; field_id?: string; name?: string; formula: FormulaDefinition };

export interface PlannedAction {
  index: number;
  kind: PlanChange['kind'];
  sheet_id: string;
  summary: string;
  decision: 'create' | 'update' | 'clear' | 'skip' | 'conflict' | 'blocked' | 'invalid' | 'unknown';
  capability: string;
  capability_status: string;
  blocked_by: { capability: string; prerequisites: string[] }[];
  differences: { path: string; before: unknown; after: unknown }[];
  depends_on: number[];
  affected: { fields: string[]; views: string[]; records: number | null };
  notes: string[];
  errors?: { code: string; message: string; details?: Record<string, unknown> }[];
  requires_provider: boolean;
}

export interface PlanResult {
  plan_id: string;
  generated_at: string;
  document_id: string;
  title: string | null;
  status: 'blocked' | 'ready';
  executable: boolean;
  snapshot: { sheets: { id: string; name: string; revision: number; total_records_in_table: number }[] };
  actions: PlannedAction[];
  order: number[];
  blocked_by: string[];
  summary: { total: number; create: number; update: number; clear: number; skip: number; conflict: number; blocked: number; invalid: number; unknown: number };
  dependencies: { cycles: string[][]; formula_cycles: string[][] };
  notes: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function planId(context: PlanContext, changes: PlanChange[]) {
  return createHash('sha256').update(canonical({ document_id: context.document_id,
    sheets: context.sheets.map(sheet => ({ id: sheet.id, revision: sheet.revision })),
    changes })).digest('hex');
}

function sheetOf(context: PlanContext, id: string) {
  const sheet = context.sheets.find(candidate => candidate.id === id);
  if (!sheet) throw new WecomError('UNKNOWN_SHEET', '计划引用了不存在或不可读取的子表。', { sheet_id: id });
  return sheet;
}

function fieldOf(sheet: PlanSheet, id: string) {
  const field = sheet.fields.find(candidate => candidate.id === id);
  if (!field) throw new WecomError('UNKNOWN_FIELD', '计划引用了不存在或不可读取的字段。', { sheet_id: sheet.id, field_id: id });
  return field;
}

function blockedFor(capabilityId: string) {
  const capability = capabilityById(capabilityId);
  return {
    capability: capability.id,
    status: capability.status,
    blocked: capability.status !== 'verified',
    prerequisites: capability.prerequisites || [],
  };
}

function actionBase(index: number, change: PlanChange, capabilityId: string): PlannedAction {
  const blocked = blockedFor(capabilityId);
  return {
    index, kind: change.kind, sheet_id: change.sheet_id, summary: '',
    decision: blocked.blocked ? 'blocked' : 'unknown', capability: capabilityId, capability_status: blocked.status,
    blocked_by: blocked.blocked ? [{ capability: blocked.capability, prerequisites: blocked.prerequisites }] : [],
    differences: [], depends_on: [], affected: { fields: [], views: [], records: null }, notes: [],
    requires_provider: blocked.status !== 'verified',
  };
}

function memberAction(context: PlanContext, change: Extract<PlanChange, { kind: 'member_cells' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const fields = change.updates.map(update => update.field_id ?? change.field_id);
  const fieldId = fields[0];
  if (!fieldId) throw new WecomError('INVALID_ARGUMENT', '成员写入需要更新项或变更项的 field_id。');
  if (fields.some(candidate => candidate !== fieldId)) throw new WecomError('INVALID_ARGUMENT', '一次成员写入变更只能针对同一个字段；请拆分计划。');
  const field = fieldOf(sheet, fieldId);
  if (field.type !== 'USER') throw new WecomError('INVALID_ARGUMENT', '成员写入目标必须是人员字段。', { field_id: field.id });
  if (change.notify_members !== false) {
    throw new WecomError('NOTIFICATION_CONTROL_UNAVAILABLE', '无法确认字段级和操作级通知均关闭；禁止写入成员。', {
      capability: 'member.cell.write', field_id: field.id });
  }
  const multiple = memberFieldMultiple(field);
  const updates: MemberUpdateInput[] = [];
  const unknown = [];
  for (const update of change.updates) {
    if ((update.field_id ?? change.field_id) !== field.id) throw new WecomError('INVALID_ARGUMENT', '更新项的字段与计划声明的字段不一致。');
    if (sheet.record_ids && !sheet.record_ids.includes(update.record_id)) {
      throw new WecomError('UNKNOWN_RECORD', '成员更新包含不存在或不可读取的记录。', { record_ids: [update.record_id] });
    }
    const currentCell = sheet.member_cells?.[update.record_id]?.[field.id];
    if (update.mode !== 'replace' && !currentCell && update.current === undefined) unknown.push(update.record_id);
    updates.push({ ...update, field_id: field.id, current: update.current ?? (currentCell?.status === 'present' ? currentCell.members : undefined) });
  }
  const plan = planMemberUpdates(multiple, updates);
  const action = actionBase(index, change, 'member.cell.write');
  action.summary = `写入 ${plan.length} 个人员单元格（${multiple ? '多人' : '单人'}字段）`;
  action.affected = { fields: [field.id], views: sheet.views.map(view => view.id), records: plan.length };
  action.differences = plan.flatMap(item => item.action === 'noop' ? [] : [{
    path: `record:${item.record_id}/${item.field_id}`,
    before: item.action === 'clear' ? 'current_members' : item.unchanged,
    after: item.action === 'clear' ? [] : item.final_members,
  }]);
  action.notes = [
    '通知必须保持关闭；写入前需确认提供方支持操作级通知控制。',
    ...plan.flatMap(item => item.notes.map(note => `${item.record_id}: ${note}`)),
  ];
  if (unknown.length) {
    action.decision = 'unknown';
    action.notes.push(`以下记录未读取原值，追加/移除无法安全计算：${unknown.join(', ')}`);
  } else if (plan.every(item => item.action === 'noop')) action.decision = 'skip';
  else action.decision = action.blocked_by.length ? 'blocked' : 'update';
  if (plan.some(item => item.action === 'clear')) action.decision = action.blocked_by.length ? 'blocked' : 'clear';
  return action;
}

function viewAction(context: PlanContext, change: Extract<PlanChange, { kind: 'view' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const plan = planViewWrite({ action: change.action, view_id: change.view_id, patch: change.patch,
    views: sheet.views, fields: sheet.fields });
  const action = actionBase(index, change, plan.requires_provider_capability);
  action.summary = `${change.action === 'create' ? '新建' : '更新'}视图「${plan.name}」`;
  action.decision = plan.decision === 'skip' ? 'skip'
    : plan.decision === 'conflict' ? 'conflict'
    : action.blocked_by.length ? 'blocked'
    : change.action === 'create' ? 'create' : 'update';
  action.differences = plan.differences;
  action.affected = { fields: sheet.fields.map(field => field.id), views: plan.view_id ? [plan.view_id] : [], records: sheet.total_records_in_table };
  action.notes = plan.notes;
  if (!plan.comparable) action.notes.push('视图筛选的现有运算符代码语义未知，无法自动判定是否已完全一致。');
  return action;
}

function fieldUpdateAction(context: PlanContext, change: Extract<PlanChange, { kind: 'field_update' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const field = fieldOf(sheet, change.field_id);
  const action = actionBase(index, change, 'field.config.write');
  action.summary = `更新字段「${field.name}」的属性`;
  const differences: PlannedAction['differences'] = [];
  if (change.patch.name !== undefined) {
    if (!change.patch.name.trim() || change.patch.name.length > 128) throw new WecomError('INVALID_ARGUMENT', '字段名需要 1–128 个字符。');
    if (change.patch.name !== field.name) differences.push({ path: 'name', before: field.name, after: change.patch.name });
  }
  if (change.patch.user_multiple !== undefined) {
    if (field.type !== 'USER') throw new WecomError('INVALID_ARGUMENT', '只有人员字段可以设置多选属性。', { field_id: field.id });
    const current = userFieldMultiple(field);
    if (current === null) action.notes.push('人员多选属性的原始语义未识别，无法自动比较。');
    else if (current !== change.patch.user_multiple) differences.push({ path: 'user_multiple', before: current, after: change.patch.user_multiple });
  }
  if (change.patch.user_notify !== undefined) {
    if (field.type !== 'USER') throw new WecomError('INVALID_ARGUMENT', '只有人员字段可以设置通知属性。', { field_id: field.id });
    const current = field.attributes?.kind === 'USER' ? field.attributes.notify_when_added : null;
    if (current !== null && current !== change.patch.user_notify) differences.push({ path: 'user_notify', before: current, after: change.patch.user_notify });
  }
  if (field.is_primary && change.patch.name !== undefined) action.notes.push('这是标题列；重命名必须保留标题列身份和现有记录内容。');
  const dependents = affectedDependents(sheet.fields, [field.id]);
  if (dependents.length) {
    action.notes.push(`依赖此字段的字段：${dependents.join(', ')}`);
    action.affected.fields = [field.id, ...dependents];
  } else action.affected.fields = [field.id];
  action.affected.views = sheet.views.filter(view => view.columns.includes(field.id) || view.group.some(item => item.field_id === field.id)
    || view.sort.some(item => item.field_id === field.id)).map(view => view.id);
  action.differences = differences;
  action.decision = differences.length ? (action.blocked_by.length ? 'blocked' : 'update') : 'skip';
  return action;
}

function existingFieldByName(sheet: PlanSheet, name: string, types: string[]) {
  const matches = sheet.fields.filter(field => field.name === name && types.includes(field.type));
  if (matches.length > 1) throw new WecomError('FIELD_AMBIGUOUS', '同名同类型字段超过一个，必须用 field_id 定位。', { name, fields: matches.map(field => field.id) });
  return matches[0];
}

function lookupAction(context: PlanContext, change: Extract<PlanChange, { kind: 'lookup_field' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const action = actionBase(index, change, 'lookup.create');
  action.summary = `新建查找引用字段「${change.name}」`;
  if (!change.name.trim()) throw new WecomError('INVALID_ARGUMENT', '查找引用字段需要名称。');
  if (!isObject(change.lookup)) throw new WecomError('INVALID_ARGUMENT', 'lookup 配置必须是对象。');
  const relationFieldId = typeof change.lookup.relation_field_id === 'string' ? change.lookup.relation_field_id : undefined;
  const conditions = Array.isArray(change.lookup.conditions) ? change.lookup.conditions : [];
  let targetSheetId = change.lookup.target_sheet_id;
  if (relationFieldId) {
    const relationField = fieldOf(sheet, relationFieldId);
    if (!['LINK_RECORDS', 'TWO_WAY_LINK_RECORDS'].includes(relationField.type)) {
      throw new WecomError('INVALID_ARGUMENT', '沿关联字段引用只能使用单向或双向关联字段。', { field_id: relationFieldId });
    }
    const relationTarget = relationField.attributes?.kind === 'RELATION'
      ? relationField.attributes.target_sheet_id : relationField.target_sheet_ids[0];
    if (!relationTarget) throw new WecomError('UNSUPPORTED_FIELD_CONFIG', '关联字段缺少可读取的目标子表。', { field_id: relationFieldId });
    if (targetSheetId !== undefined && targetSheetId !== relationTarget) {
      throw new WecomError('INVALID_ARGUMENT', '目标子表与关联字段指向的子表不一致。', { target_sheet_id: targetSheetId, relation_target: relationTarget });
    }
    targetSheetId = relationTarget;
    if (conditions.length) throw new WecomError('INVALID_ARGUMENT', '沿关联字段引用不能同时提供条件匹配。');
    action.notes.push('沿关联字段引用：由来源记录已关联的目标记录集合读取目标字段。');
  } else if (typeof targetSheetId !== 'string') {
    throw new WecomError('INVALID_ARGUMENT', '条件匹配模式需要 target_sheet_id。');
  }
  const aggregation = change.lookup.aggregation ?? 'values';
  if (!['values', 'unique', 'sum', 'count', 'count_unique', 'average', 'max', 'min'].includes(String(aggregation))) {
    throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '不支持的统计方式。', { aggregation });
  }
  const targetSheet = sheetOf(context, targetSheetId as string);
  const targetFieldId = change.lookup.target_field_id;
  if (typeof targetFieldId !== 'string' || !targetSheet.fields.some(field => field.id === targetFieldId)) {
    throw new WecomError('UNKNOWN_FIELD', '查找引用的目标字段不属于目标子表。', { target_sheet_id: targetSheet.id, field_id: targetFieldId });
  }
  if (!relationFieldId && (!conditions.length || conditions.length > 20)) {
    throw new WecomError('INVALID_ARGUMENT', '查找引用需要 1–20 个匹配条件。');
  }
  const sides: Record<'source' | 'target', PlanSheet> = { source: sheet, target: targetSheet };
  for (const [conditionIndex, condition] of conditions.entries()) {
    if (!isObject(condition) || !isObject(condition.left) || typeof condition.operator !== 'string') {
      throw new WecomError('INVALID_ARGUMENT', '查找条件结构无效。', { index: conditionIndex });
    }
    const left = condition.left;
    const leftScope = left.scope as 'source' | 'target';
    if (!['source', 'target'].includes(left.scope) || typeof left.field_id !== 'string'
      || !sides[leftScope].fields.some(field => field.id === left.field_id)) {
      throw new WecomError('UNKNOWN_FIELD', '查找条件左侧字段不属于声明的作用域。', { index: conditionIndex });
    }
    const hasRight = isObject(condition.right);
    const hasValue = condition.value !== undefined;
    const emptyOperator = ['is_empty', 'not_empty', 'empty'].includes(condition.operator);
    if (emptyOperator && (hasRight || hasValue)) {
      throw new WecomError('INVALID_ARGUMENT', '空值条件不能同时提供匹配字段或固定值。', { index: conditionIndex });
    }
    if (emptyOperator) {
      throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '空值条件尚未验证；请使用 eq/contains 条件。', { index: conditionIndex });
    }
    if (condition.operator !== 'eq' && condition.operator !== 'contains') {
      throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '当前只验证了 eq/contains 条件。', { index: conditionIndex });
    }
    if (left.scope !== 'target') {
      throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '查找条件左侧必须是目标表字段。', { index: conditionIndex });
    }
    if (hasRight && hasValue) {
      throw new WecomError('INVALID_ARGUMENT', '查找条件不能同时提供本表字段和固定值。', { index: conditionIndex });
    }
    if (!hasRight && !hasValue) {
      throw new WecomError('INVALID_ARGUMENT', '查找条件需要本表字段或固定值。', { index: conditionIndex });
    }
    if (hasRight) {
      const right = condition.right as Record<string, unknown>;
      if (right.scope !== 'source' || typeof right.field_id !== 'string'
        || !sides.source.fields.some(field => field.id === right.field_id)) {
        throw new WecomError('UNKNOWN_FIELD', '查找条件右侧字段不属于本表。', { index: conditionIndex });
      }
      if (sides.target.fields.find(field => field.id === left.field_id)?.type
        !== sides.source.fields.find(field => field.id === right.field_id)?.type) {
        action.notes.push(`条件 ${conditionIndex + 1} 两侧字段类型不同；数字任务号与文本任务号的转换规则必须明确。`);
      }
    } else {
      const targetConditionField = sides.target.fields.find(field => field.id === left.field_id);
      if (!targetConditionField) throw new WecomError('UNKNOWN_FIELD', '查找条件左侧字段不属于目标表。', { index: conditionIndex });
      const type = targetConditionField.type;
      if (type === 'TEXT') {
        if (typeof condition.value !== 'string') throw new WecomError('INVALID_ARGUMENT', '文本固定值必须是字符串。', { index: conditionIndex });
      } else if (type === 'SINGLE_SELECT' || type === 'MULTIPLE_SELECT') {
        const ids = Array.isArray(condition.value) ? condition.value : typeof condition.value === 'string' ? [condition.value] : [];
        if (!ids.length || ids.some((id: unknown) => typeof id !== 'string' || !targetConditionField.options?.some(option => option.id === id))) {
          throw new WecomError('UNKNOWN_OPTION', '固定值必须是目标字段的已有选项 ID。', { index: conditionIndex });
        }
      } else if (type === 'NUMBER' || type === 'DATE_TIME') {
        if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) {
          throw new WecomError('INVALID_ARGUMENT', `${type} 固定值必须是数字。`, { index: conditionIndex });
        }
      } else {
        throw new WecomError('UNSUPPORTED_LOOKUP_CONFIG', '此字段类型的固定值条件尚未验证。', { index: conditionIndex, type });
      }
    }
  }
  action.affected.fields = [change.name];
  const existing = existingFieldByName(sheet, change.name, ['LOOKUP']);
  if (existing) {
    action.decision = action.blocked_by.length ? 'blocked' : 'unknown';
    action.notes.push('同名查找引用字段已存在；原始配置未解释，不能自动判定是否相同。');
    action.affected.fields = [existing.id];
  } else {
    action.decision = action.blocked_by.length ? 'blocked' : 'create';
    action.differences = [{ path: 'name', before: undefined, after: change.name }];
  }
  action.notes.push(`目标子表：${targetSheet.name}（${targetSheet.id}）。零匹配返回空，多匹配不得擅自取第一条。`);
  return action;
}

function relationFieldAction(context: PlanContext, change: Extract<PlanChange, { kind: 'relation_field' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const target = sheetOf(context, change.relation.target_sheet_id);
  const action = actionBase(index, change, 'relation.create');
  action.summary = `新建${change.relation.two_way ? '双向' : '单向'}关联字段「${change.name}」`;
  if (!change.name.trim()) throw new WecomError('INVALID_ARGUMENT', '关联字段需要名称。');
  if (change.relation.target_sheet_id === sheet.id && !change.relation.two_way) {
    action.notes.push('关联目标与来源是同一子表。');
  }
  const existing = existingFieldByName(sheet, change.name, ['LINK_RECORDS', 'TWO_WAY_LINK_RECORDS']);
  if (existing) {
    action.decision = action.blocked_by.length ? 'blocked' : 'unknown';
    action.notes.push('同名关联字段已存在；原始配置未解释，不能自动判定目标表和多选属性。');
    action.affected.fields = [existing.id];
  } else {
    action.decision = action.blocked_by.length ? 'blocked' : 'create';
    action.differences = [{ path: 'name', before: undefined, after: change.name },
      { path: 'target_sheet_id', before: undefined, after: target.id }];
  }
  if (change.relation.two_way) action.notes.push('双向关联会在目标表自动创建反向字段，必须把两侧字段和变化一起列入验收。');
  action.affected.views = sheet.views.map(view => view.id);
  return action;
}

function relationCellsAction(context: PlanContext, change: Extract<PlanChange, { kind: 'relation_cells' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const field = fieldOf(sheet, change.field_id);
  if (!['LINK_RECORDS', 'TWO_WAY_LINK_RECORDS'].includes(field.type)) {
    throw new WecomError('INVALID_ARGUMENT', '关联单元格写入目标必须是单向或双向关联字段。', { field_id: field.id });
  }
  const action = actionBase(index, change, 'relation.cell.write');
  action.summary = `写入 ${change.updates.length} 个${field.type === 'TWO_WAY_LINK_RECORDS' ? '双向' : '单向'}关联单元格`;
  const recordIds = new Set(change.updates.map(update => update.record_id));
  if (recordIds.size !== change.updates.length) throw new WecomError('INVALID_ARGUMENT', '关联更新包含重复记录。');
  if (sheet.record_ids) {
    const missing = [...recordIds].filter(id => !sheet.record_ids!.includes(id));
    if (missing.length) throw new WecomError('UNKNOWN_RECORD', '关联更新包含不存在或不可读取的记录。', { record_ids: missing });
  }
  action.affected = { fields: [field.id], views: sheet.views.map(view => view.id), records: change.updates.length };
  action.differences = change.updates.map(update => ({ path: `record:${update.record_id}/${field.id}`,
    before: 'current_relations_not_read', after: update.target_record_ids }));
  action.decision = action.blocked_by.length ? 'blocked' : 'unknown';
  action.notes.push('关联单元格必须使用稳定的目标记录 ID，并按集合比较；目标删除或不可访问时报告悬空引用。');
  return action;
}

function formulaAction(context: PlanContext, change: Extract<PlanChange, { kind: 'formula_field' }>, index: number): PlannedAction {
  const sheet = sheetOf(context, change.sheet_id);
  const action = actionBase(index, change, change.action === 'create' ? 'formula.create' : 'formula.update');
  const name = change.name ?? (change.field_id ? fieldOf(sheet, change.field_id).name : undefined);
  if (!name) throw new WecomError('INVALID_ARGUMENT', '公式字段需要名称或用 field_id 定位。');
  action.summary = `${change.action === 'create' ? '新建' : '更新'}公式字段「${name}」`;
  if (change.formula.format !== undefined) action.notes.push('公式展示格式已按网页端真实编码写入；写入后需回读核对格式类型。');
  const callNames = new Set<string>();
  const collect = (node: FormulaExpression): void => {
    if (node.kind === 'call') { callNames.add(node.name); node.args.forEach(collect); return; }
    if (node.kind === 'binary') { collect(node.left); collect(node.right); return; }
    if (node.kind === 'unary') { collect(node.operand); }
  };
  collect(change.formula.expression);
  const unsupported = [...callNames].filter(name => !PROVIDER_FORMULA_CALLS.has(name));
  if (unsupported.length) {
    throw new WecomError('UNSUPPORTED_FORMULA', '这些函数尚未验证网页公式编码，未生成可执行计划。', { functions: unsupported });
  }
  const validation = validateFormulaDefinition(change.formula, sheet.fields,
    { field_id: change.action === 'update' ? change.field_id : undefined });
  if (validation.status === 'invalid') {
    throw new WecomError('FORMULA_INVALID', '公式表达式未通过本地校验；未生成可执行计划。', {
      errors: validation.errors, inferred_type: validation.inferred_type });
  }
  action.affected = { fields: validation.dependencies, views: sheet.views.map(view => view.id), records: sheet.total_records_in_table };
  action.notes.push(`表达式类型：${validation.inferred_type}；声明类型：${validation.result_type}。`,
    validation.calculation_note);
  if (change.action === 'update') {
    if (!change.field_id) throw new WecomError('INVALID_ARGUMENT', '更新公式必须提供 field_id。');
    const field = fieldOf(sheet, change.field_id);
    if (field.type !== 'FORMULA') throw new WecomError('INVALID_ARGUMENT', 'field_id 不是公式字段。', { field_id: field.id });
    action.differences = [{ path: 'formula', before: 'unverified_raw', after: change.formula.expression }];
    action.decision = action.blocked_by.length ? 'blocked' : 'update';
  } else {
    const existing = existingFieldByName(sheet, name, ['FORMULA']);
    if (existing) {
      action.decision = action.blocked_by.length ? 'blocked' : 'unknown';
      action.notes.push('同名公式字段已存在；配置未解释，不能自动判定是否相同。');
    } else {
      action.decision = action.blocked_by.length ? 'blocked' : 'create';
      action.differences = [{ path: 'name', before: undefined, after: name },
        { path: 'formula', before: undefined, after: change.formula.expression }];
    }
  }
  return action;
}

const ORDER: Record<PlanChange['kind'], number> = {
  field_update: 0, relation_field: 1, lookup_field: 2, relation_cells: 3, formula_field: 4, member_cells: 5, view: 6,
};

function capabilityForChange(change: PlanChange): string {
  switch (change.kind) {
    case 'member_cells': return 'member.cell.write';
    case 'view': return change.action === 'create' ? 'view.create' : 'view.update';
    case 'field_update': return 'field.config.write';
    case 'lookup_field': return 'lookup.create';
    case 'relation_field': return 'relation.create';
    case 'relation_cells': return 'relation.cell.write';
    case 'formula_field': return change.action === 'create' ? 'formula.create' : 'formula.update';
    default: return 'plan.local';
  }
}

export function planChanges(context: PlanContext, changes: PlanChange[]): PlanResult {
  if (!changes.length) throw new WecomError('INVALID_ARGUMENT', '计划至少需要一个变更项。');
  // 单条变更的语法/依赖错误记录为 invalid，不丢弃其余变更；跨文档/子表不存在才属于整体失败。
  const actions = changes.map((change, index) => {
    try {
      switch (change.kind) {
        case 'member_cells': return memberAction(context, change, index);
        case 'view': return viewAction(context, change, index);
        case 'field_update': return fieldUpdateAction(context, change, index);
        case 'lookup_field': return lookupAction(context, change, index);
        case 'relation_field': return relationFieldAction(context, change, index);
        case 'relation_cells': return relationCellsAction(context, change, index);
        case 'formula_field': return formulaAction(context, change, index);
        default: throw new WecomError('INVALID_ARGUMENT', '未知的计划变更类型。');
      }
    } catch (error) {
      const action = actionBase(index, change, capabilityForChange(change));
      action.decision = 'invalid';
      action.summary = `${change.kind} 变更未通过本地校验`;
      action.notes = [error instanceof Error ? error.message : '本地校验失败。'];
      action.errors = [{
        code: error instanceof WecomError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '本地校验失败。',
        ...(error instanceof WecomError && error.details ? { details: error.details } : {}),
      }];
      return action;
    }
  });
  // 同一字段上的属性更新必须先于成员写入；关联字段先于关联单元格和引用。
  for (const action of actions) {
    action.depends_on = actions.filter(other => other.index !== action.index && (
      (action.kind === 'member_cells' && other.kind === 'field_update' && other.sheet_id === action.sheet_id && other.affected.fields[0] === action.affected.fields[0])
      || (['relation_cells', 'lookup_field', 'formula_field'].includes(action.kind) && other.kind === 'relation_field' && other.sheet_id === action.sheet_id)
      || (action.kind === 'formula_field' && other.kind === 'lookup_field' && other.sheet_id === action.sheet_id)
    )).map(other => other.index);
  }
  const order = [...actions].sort((left, right) => ORDER[left.kind] - ORDER[right.kind] || left.index - right.index).map(action => action.index);
  const blocked = [...new Set(actions.flatMap(action => action.blocked_by.map(item => item.capability)))];
  const summary = {
    total: actions.length,
    create: actions.filter(action => action.decision === 'create').length,
    update: actions.filter(action => action.decision === 'update').length,
    clear: actions.filter(action => action.decision === 'clear').length,
    skip: actions.filter(action => action.decision === 'skip').length,
    conflict: actions.filter(action => action.decision === 'conflict').length,
    blocked: actions.filter(action => action.decision === 'blocked').length,
    invalid: actions.filter(action => action.decision === 'invalid').length,
    unknown: actions.filter(action => action.decision === 'unknown').length,
  };
  const allFields = context.sheets.flatMap(sheet => sheet.fields);
  const deps = dependencyCycles(allFields);
  return {
    plan_id: planId(context, changes),
    generated_at: new Date().toISOString(),
    document_id: context.document_id,
    title: context.title || null,
    status: summary.blocked || summary.invalid ? 'blocked' : 'ready',
    executable: summary.blocked === 0 && summary.invalid === 0 && summary.conflict === 0,
    snapshot: { sheets: context.sheets.map(sheet => ({ id: sheet.id, name: sheet.name,
      revision: sheet.revision, total_records_in_table: sheet.total_records_in_table })) },
    actions,
    order,
    blocked_by: blocked,
    summary,
    dependencies: { cycles: deps, formula_cycles: [] },
    notes: [
      '本计划只读取线上结构并生成本地差异，不提交任何写入。',
      summary.blocked ? '存在未验证的提供方能力，计划不可执行；线上内容保持原状。' : '所有变更项的提供方能力均已验证，仍需按顺序执行并回读核对。',
      '重复执行同一计划应先重新读取；成员/视图/字段均按内容比较，相同配置应得到空差异。',
      '未识别的字段/视图原始设置不会被本计划覆盖。',
    ],
  };
}

export interface VerifyAction {
  index: number;
  kind: PlanChange['kind'];
  sheet_id: string;
  summary: string;
  status: 'verified' | 'pending' | 'conflict' | 'unknown' | 'skip';
  details: string[];
  differences: { path: string; expected: unknown; actual: unknown }[];
}

export function verifyChanges(context: PlanContext, changes: PlanChange[]): {
  document_id: string;
  generated_at: string;
  status: 'verified' | 'partial' | 'pending' | 'unknown';
  actions: VerifyAction[];
  summary: Record<'verified' | 'pending' | 'conflict' | 'unknown' | 'skip', number>;
} {
  const actions: VerifyAction[] = changes.map((change, index) => {
    if (change.kind === 'member_cells') {
      const sheet = sheetOf(context, change.sheet_id);
      const fieldId = change.field_id ?? change.updates[0]?.field_id;
      if (!fieldId) return { index, kind: change.kind, sheet_id: sheet.id, summary: '核对人员单元格',
        status: 'unknown', details: ['缺少字段 ID。'], differences: [] };
      const field = fieldOf(sheet, fieldId);
      const multiple = memberFieldMultiple(field);
      if (!sheet.member_cells) return { index, kind: change.kind, sheet_id: sheet.id, summary: '核对人员单元格',
        status: 'unknown', details: ['未读取当前人员单元格；不能断言写入结果。'], differences: [] };
      try {
        const planned = planMemberUpdates(multiple, change.updates.map(update => ({
          ...update, field_id: fieldId,
          current: update.current ?? (sheet.member_cells?.[update.record_id]?.[fieldId]?.status === 'present'
            ? sheet.member_cells[update.record_id][fieldId].members : undefined),
        })));
        const details: string[] = [];
        const differences: VerifyAction['differences'] = [];
        let verified = true;
        for (const item of planned) {
          const cell = sheet.member_cells[item.record_id]?.[fieldId];
          if (!cell) { verified = false; details.push(`${item.record_id}: 未读取当前值。`); continue; }
          const comparison = compareMemberCell(item.final_members, cell, multiple);
          if (!comparison.match) {
            verified = false;
            differences.push({ path: `${item.record_id}/${fieldId}`, expected: item.final_members, actual: cell.members });
            details.push(`${item.record_id}: 实际成员与目标不一致${comparison.unresolved ? '（unresolved）' : comparison.not_returned ? '（not_returned，不能当作空值）' : ''}。`);
          } else details.push(`${item.record_id}: 按身份引用一致。`);
        }
        return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对 ${planned.length} 个人员单元格`,
          status: verified ? 'verified' : 'pending', details, differences };
      } catch (error) {
        return { index, kind: change.kind, sheet_id: sheet.id, summary: '核对人员单元格', status: 'unknown',
          details: [error instanceof Error ? error.message : '无法核对。'], differences: [] };
      }
    }
    if (change.kind === 'view') {
      const sheet = sheetOf(context, change.sheet_id);
      try {
        const plan = planViewWrite({ action: change.action, view_id: change.view_id, patch: change.patch,
          views: sheet.views, fields: sheet.fields });
        if (!plan.comparable) return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对视图「${plan.name}」`,
          status: 'unknown', details: ['视图筛选/看板配置的原始语义未验证，无法自动确认完全一致。'], differences: [] };
        if (plan.decision === 'skip') return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对视图「${plan.name}」`,
          status: 'verified', details: ['当前视图配置与目标一致。'], differences: [] };
        if (plan.decision === 'conflict') return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对视图「${plan.name}」`,
          status: 'conflict', details: ['存在同名但配置不同的视图。'], differences: [] };
        return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对视图「${plan.name}」`,
          status: plan.decision === 'create' ? 'pending' : 'pending',
          details: [plan.decision === 'create' ? '目标视图尚不存在。' : '视图仍有未应用的差异。'],
          differences: plan.differences.map(item => ({ path: item.path, expected: item.after, actual: item.before })) };
      } catch (error) {
        return { index, kind: change.kind, sheet_id: sheet.id, summary: '核对视图', status: 'unknown',
          details: [error instanceof Error ? error.message : '无法核对。'], differences: [] };
      }
    }
    if (change.kind === 'field_update') {
      const sheet = sheetOf(context, change.sheet_id);
      const field = fieldOf(sheet, change.field_id);
      const differences: VerifyAction['differences'] = [];
      const unknown: string[] = [];
      if (change.patch.name !== undefined && field.name !== change.patch.name) {
        differences.push({ path: 'name', expected: change.patch.name, actual: field.name });
      }
      if (change.patch.user_multiple !== undefined) {
        const actual = userFieldMultiple(field);
        if (actual === null) unknown.push('人员多选属性未识别，不能断言已一致。');
        else if (actual !== change.patch.user_multiple) differences.push({ path: 'user_multiple', expected: change.patch.user_multiple, actual });
      }
      if (change.patch.user_notify !== undefined) {
        const actual = field.attributes?.kind === 'USER' ? field.attributes.notify_when_added : null;
        if (actual === null) unknown.push('人员通知属性未识别，不能断言已一致。');
        else if (actual !== change.patch.user_notify) differences.push({ path: 'user_notify', expected: change.patch.user_notify, actual });
      }
      return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对字段「${field.name}」`,
        status: differences.length ? 'pending' : unknown.length ? 'unknown' : 'verified',
        details: differences.length ? ['字段属性尚未更新到目标值。'] : unknown.length ? unknown : ['字段属性与目标一致。'], differences };
    }
    if (change.kind === 'relation_cells') {
      return { index, kind: change.kind, sheet_id: change.sheet_id, summary: '核对关联单元格', status: 'unknown',
        details: ['关联单元格的当前值尚未纳入本地模型；需要提供方读取能力后再核对。'], differences: [] };
    }
    // lookup/formula/relation field：只能确认同名同类型字段是否存在，配置内容未知。
    const sheet = sheetOf(context, change.sheet_id);
    const types: Record<string, string[]> = { lookup_field: ['LOOKUP'], formula_field: ['FORMULA'],
      relation_field: ['LINK_RECORDS', 'TWO_WAY_LINK_RECORDS'] };
    const name = change.kind === 'formula_field'
      ? change.name ?? (change.field_id ? fieldOf(sheet, change.field_id).name : '')
      : (change as any).name;
    const existing = sheet.fields.filter(field => field.name === name && types[change.kind].includes(field.type));
    return { index, kind: change.kind, sheet_id: sheet.id, summary: `核对字段「${name}」`,
      status: existing.length ? 'unknown' : 'pending',
      details: [existing.length ? '字段已存在，但原始配置未解释，无法确认配置与计算是否正确。' : '目标字段尚不存在。'],
      differences: [] };
  });
  const summary = { verified: 0, pending: 0, conflict: 0, unknown: 0, skip: 0 };
  for (const action of actions) summary[action.status] += 1;
  const status = summary.conflict ? 'partial' : summary.pending ? 'pending' : summary.unknown ? 'unknown' : 'verified';
  return { document_id: context.document_id, generated_at: new Date().toISOString(), status, actions, summary };
}
