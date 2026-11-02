import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields } from '../dist/fields.js';
import { normalizeView } from '../dist/views.js';
import { planChanges, verifyChanges } from '../dist/planner.js';

const rawFields = {
  k9: 'f_title',
  k4: [],
  k3: {
    f_title: { k30: '职责标题', k31: 1 },
    f_owner: { k30: '承担人员（成员）', k31: 7, k7: { k1: false, k2: false } },
    f_collab: { k30: '协作人员（成员）', k31: 7, k7: { k1: true, k2: true } },
    f_count: { k30: '年度事项数', k31: 2, k2: { k1: 0, k2: false } },
    f_status: { k30: '执行状态', k31: 17, k17: { k1: false, k2: true, k3: [{ k1: 'o_done', k2: '已完成', k3: 15 }] } },
    f_subtask: { k30: '来源子任务编号', k31: 1 },
    f_rel: { k30: '关联子任务', k31: 18, k18: { k1: 't_sub' } },
    f_existing_lookup: { k30: '已有引用', k31: 20, k20: { k1: 'f_title', k2: 't_sub' } },
    f_owner_lookup: { k30: '负责人引用', k31: 20, k20: { k1: 'f_owner', k2: 't_sub' } },
  },
};
const fields = normalizeFields(schemaFromRaw(rawFields), ['t_sub', 't_tasks']);
const view = normalizeView({
  k30: 'v_all', k31: '全部记录', k32: 1, k33: 0, k34: 'owner', k35: 1, k37: [], k38: {},
  k1: { k1: [], k2: fields.map(field => field.id), k3: 1, k4: 1, k5: {}, k6: true, k7: [], k8: { k1: 0, k2: [] }, k9: [], k10: true, k13: '' },
}, fields);

const u1 = { namespace: 'corp', id: 'u1', name: '甲' };
const u2 = { namespace: 'corp', id: 'u2', name: '乙' };
const memberCell = members => ({ status: 'present', members, unresolved: [], namespace_status: 'resolved' });

function context(overrides = {}) {
  return {
    document_id: 'doc_example',
    title: '示例文档',
    sheets: [{
      id: 't_people', name: '人员具体分工', revision: 36, total_records_in_table: 2, fields, views: [view],
      record_ids: ['r1', 'r2'],
      member_cells: { r1: { f_owner: memberCell([u1]) }, r2: { f_owner: memberCell([]) } },
      ...overrides,
    }, {
      id: 't_sub', name: '子任务实施安排', revision: 36, total_records_in_table: 1, fields, views: [],
      record_ids: ['r_target'], member_cells: {},
    }],
  };
}

function baseChanges() {
  return [
    { kind: 'field_update', sheet_id: 't_people', field_id: 'f_owner', patch: { user_multiple: true } },
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [u2] },
        { record_id: 'r2', field_id: 'f_owner', mode: 'replace', members: [] }] },
    { kind: 'view', action: 'create', sheet_id: 't_people', patch: { name: '按人员查看', type: 'grid' } },
    { kind: 'lookup_field', sheet_id: 't_people', name: '子任务名称（引用）', lookup: {
      target_sheet_id: 't_sub', target_field_id: 'f_title', conditions: [{ left: { scope: 'target', field_id: 'f_subtask' }, operator: 'eq', right: { scope: 'source', field_id: 'f_subtask' } }], aggregation: 'values' } },
    { kind: 'relation_field', sheet_id: 't_people', name: '关联子任务（新）', relation: { target_sheet_id: 't_sub', multiple: true, two_way: false } },
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '完成率', formula: {
      expression: { kind: 'binary', operator: 'divide', left: { kind: 'field', field_id: 'f_count' }, right: { kind: 'constant', value: 2 } },
      result_type: 'number', dependencies: ['f_count'] } },
    { kind: 'relation_cells', sheet_id: 't_people', field_id: 'f_rel', updates: [{ record_id: 'r1', target_record_ids: ['r_target'] }] },
  ];
}

test('计划：计算差异与依赖顺序，已验证能力不再阻塞', () => {
  const plan = planChanges(context(), baseChanges());
  assert.equal(plan.status, 'ready');
  assert.equal(plan.executable, true);
  assert.equal(plan.actions.length, 7);
  assert.deepEqual(plan.blocked_by, []);
  const fieldUpdate = plan.actions[0];
  assert.equal(fieldUpdate.decision, 'update');
  assert.deepEqual(fieldUpdate.differences, [{ path: 'user_multiple', before: false, after: true }]);
  assert.ok(fieldUpdate.notes.some(note => note.includes('依赖')));
  const member = plan.actions[1];
  assert.equal(member.decision, 'clear');
  assert.ok(member.notes.some(note => note.includes('通知')));
  const viewAction = plan.actions[2];
  assert.equal(viewAction.decision, 'create');
  assert.equal(plan.order[0], 0);
  assert.equal(plan.order.at(-1), 2);
  assert.ok(plan.order.indexOf(0) < plan.order.indexOf(1));
  const formula = plan.actions[5];
  assert.ok(formula.notes.some(note => note.includes('计算状态')));
});

test('计划 ID 对相同结构与变更稳定，便于重复执行识别', () => {
  const first = planChanges(context(), baseChanges());
  const second = planChanges(context(), baseChanges());
  assert.equal(first.plan_id, second.plan_id);
  assert.equal(first.plan_id.length, 64);
  assert.notEqual(first.generated_at, undefined);
  assert.notEqual(planChanges({ ...context(), document_id: 'other_doc' }, baseChanges()).plan_id, first.plan_id);
});

test('重复执行同一配置得到空差异，计划变为可执行（不产生写入）', () => {
  const plan = planChanges(context(), [
    { kind: 'field_update', sheet_id: 't_people', field_id: 'f_owner', patch: { user_multiple: false } },
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [u1] }] },
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_all', patch: { name: '全部记录' } },
  ]);
  assert.equal(plan.summary.skip, 3);
  assert.equal(plan.summary.blocked, 0);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.executable, true);
});

test('同名视图新建返回 conflict 而不是静默覆盖', () => {
  const plan = planChanges(context(), [{ kind: 'view', action: 'create', sheet_id: 't_people', patch: { name: '全部记录', type: 'grid' } }]);
  assert.equal(plan.actions[0].decision, 'conflict');
});

test('追加/移除缺少原值、通知未关闭和动态“我”条件都逐项标记 invalid，不丢弃其余变更', () => {
  const plan = planChanges({ ...context(), sheets: [{ ...context().sheets[0], member_cells: {} }] }, [
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'add', members: [u2] }] },
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: true,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [u2] }] },
    { kind: 'view', action: 'create', sheet_id: 't_people', patch: { name: '我的职责', filter: { conjunction: 'and', conditions: [
      { field_id: 'f_owner', operator: 'contains', value_kind: 'current_viewer' }] } } },
  ]);
  assert.deepEqual(plan.actions.map(action => action.decision), ['invalid', 'invalid', 'create']);
  assert.deepEqual(plan.actions.slice(0, 2).map(action => action.errors[0].code), [
    'ORIGINAL_VALUE_REQUIRED', 'NOTIFICATION_CONTROL_UNAVAILABLE',
  ]);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.executable, false);
});

test('查找引用支持字段对字段和固定值条件，并拒绝空值条件携带匹配值', () => {
  const plan = planChanges(context(), [
    { kind: 'lookup_field', sheet_id: 't_people', name: '年度事项数（引用）', lookup: {
      target_sheet_id: 't_sub', target_field_id: 'f_title',
      conditions: [{ left: { scope: 'target', field_id: 'f_subtask' }, operator: 'eq', right: { scope: 'source', field_id: 'f_subtask' } },
        { left: { scope: 'target', field_id: 'f_status' }, operator: 'eq', value: 'o_done' }],
      aggregation: 'count' } },
    { kind: 'lookup_field', sheet_id: 't_people', name: '错误条件（引用）', lookup: {
      target_sheet_id: 't_sub', target_field_id: 'f_title',
      conditions: [{ left: { scope: 'target', field_id: 'f_subtask' }, operator: 'empty', value: 'x' }], aggregation: 'count' } },
  ]);
  assert.equal(plan.actions[0].decision, 'create');
  assert.equal(plan.actions[1].decision, 'invalid');
  assert.equal(plan.actions[1].errors[0].code, 'INVALID_ARGUMENT');
});

test('公式无效时逐项标记 invalid，不把配置错误当作可用公式', () => {
  const plan = planChanges(context(), [
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '错误公式',
      formula: { expression: { kind: 'field', field_id: 'f_missing' }, result_type: 'number' } },
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_all', patch: { name: '全部记录' } },
  ]);
  assert.equal(plan.actions[0].decision, 'invalid');
  assert.equal(plan.actions[0].errors[0].code, 'FORMULA_INVALID');
  assert.equal(plan.actions[1].decision, 'skip');
});

test('计划：COALESCE/PERCENT/文本 COUNTIF 以 UNSUPPORTED_FORMULA 拒绝，数值 COUNTIF 可执行', () => {
  const plan = planChanges(context(), [
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '空值回退',
      formula: { expression: { kind: 'call', name: 'coalesce', args: [
        { kind: 'field', field_id: 'f_title' }, { kind: 'constant', value: '未填写' }] }, result_type: 'text' } },
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '比例',
      formula: { expression: { kind: 'call', name: 'percent', args: [
        { kind: 'constant', value: 1 }, { kind: 'constant', value: 2 }] }, result_type: 'number' } },
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '文本计数',
      formula: { expression: { kind: 'call', name: 'count_equals', args: [
        { kind: 'field', field_id: 'f_title' }, { kind: 'constant', value: '已完成' }] }, result_type: 'number' } },
    { kind: 'formula_field', action: 'create', sheet_id: 't_people', name: '数值计数',
      formula: { expression: { kind: 'call', name: 'count_equals', args: [
        { kind: 'field', field_id: 'f_count' }, { kind: 'constant', value: 0 }] }, result_type: 'number', dependencies: ['f_count'] } },
  ]);
  assert.equal(plan.executable, false);
  for (const action of plan.actions.slice(0, 3)) {
    assert.equal(action.decision, 'invalid');
    assert.equal(action.errors[0].code, 'UNSUPPORTED_FORMULA');
    assert.ok(Array.isArray(action.errors[0].details.unsupported));
  }
  assert.equal(plan.actions[0].errors[0].details.unsupported[0].provider_error_type, 8);
  assert.equal(plan.actions[1].errors[0].details.unsupported[0].provider_error_type, 8);
  assert.equal(plan.actions[2].errors[0].details.unsupported[0].provider_error_type, 4);
  assert.equal(plan.actions[2].errors[0].details.unsupported[0].field_type, 'TEXT');
  assert.equal(plan.actions[3].decision, 'create');
  assert.equal(plan.actions[3].errors, undefined);
});

test('核对：成员按身份比较，视图按规范化配置比较，未解释配置报告 unknown', () => {
  const pending = verifyChanges(context(), [
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [u2] }] },
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_all', patch: { name: '已改名' } },
    { kind: 'lookup_field', sheet_id: 't_people', name: '已有引用', lookup: {
      target_sheet_id: 't_sub', target_field_id: 'f_title', conditions: [{ left: { scope: 'target', field_id: 'f_subtask' }, operator: 'eq' }], aggregation: 'values' } },
  ]);
  assert.equal(pending.actions[0].status, 'pending');
  assert.equal(pending.actions[1].status, 'pending');
  assert.equal(pending.actions[2].status, 'unknown');
  assert.equal(pending.status, 'pending');

  const done = verifyChanges(context({ member_cells: { r1: { f_owner: memberCell([u2]) }, r2: { f_owner: memberCell([]) } } }), [
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [u2] }] },
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_all', patch: { name: '全部记录' } },
  ]);
  assert.equal(done.actions[0].status, 'verified');
  assert.equal(done.actions[1].status, 'verified');
  assert.equal(done.status, 'verified');

  const notReturned = verifyChanges(context({ member_cells: { r1: {
    f_owner: { status: 'not_returned', members: [], unresolved: [], namespace_status: 'missing' } } } }), [
    { kind: 'member_cells', sheet_id: 't_people', field_id: 'f_owner', notify_members: false,
      updates: [{ record_id: 'r1', field_id: 'f_owner', mode: 'replace', members: [] }] },
  ]);
  assert.equal(notReturned.actions[0].status, 'pending');
  assert.ok(notReturned.actions[0].details.some(detail => detail.includes('not_returned')));
});

const allFieldIds = fields.map(field => field.id);
const hiddenExample = ['f_status', 'f_owner', 'f_title'];

function hiddenView(id, name, { hidden = hiddenExample, widths = {} } = {}) {
  return normalizeView({
    k30: id, k31: name, k32: 1, k33: 0, k34: 'owner', k35: 1, k37: [], k38: {},
    k1: {
      k1: hidden, k2: allFieldIds, k3: 1, k4: 1,
      k5: Object.fromEntries(allFieldIds.map(fieldId => [fieldId,
        { k1: widths[fieldId] ?? 100, k2: hidden.includes(fieldId) }])),
      k6: true, k7: [], k8: null, k9: [], k10: true, k13: '',
    },
  }, fields);
}

test('核对：隐藏列乱序判 verified，缺少/多出隐藏列按具体路径判 pending', () => {
  const views = [hiddenView('v_hidden', '隐藏列视图')];
  const reordered = verifyChanges(context({ views }), [
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_hidden',
      patch: { hidden_fields: ['f_title', 'f_owner', 'f_status'] } },
  ]);
  assert.equal(reordered.actions[0].status, 'verified');
  assert.deepEqual(reordered.actions[0].differences, []);

  const changed = verifyChanges(context({ views }), [
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_hidden',
      patch: { hidden_fields: ['f_title', 'f_owner'] } },
  ]);
  assert.equal(changed.actions[0].status, 'pending');
  assert.deepEqual(changed.actions[0].differences, [
    { path: 'hidden_fields.extra.f_status', expected: false, actual: true },
  ]);

  const added = verifyChanges(context({ views }), [
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_hidden',
      patch: { hidden_fields: ['f_title', 'f_owner', 'f_status', 'f_count'] } },
  ]);
  assert.equal(added.actions[0].status, 'pending');
  assert.deepEqual(added.actions[0].differences, [
    { path: 'hidden_fields.missing.f_count', expected: true, actual: false },
  ]);
});

test('核对：列宽补丁只验证请求键，A=300/实际 299 报 widths.A，未请求键不报差异', () => {
  const views = [hiddenView('v_widths', '列宽视图', { widths: { f_title: 299, f_owner: 140, f_count: 0 } })];
  const wrong = verifyChanges(context({ views }), [
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_widths',
      patch: { widths: { f_title: 300 } } },
  ]);
  assert.equal(wrong.actions[0].status, 'pending');
  assert.deepEqual(wrong.actions[0].differences, [
    { path: 'widths.f_title', expected: 300, actual: 299 },
  ]);

  const applied = verifyChanges(context({ views }), [
    { kind: 'view', action: 'update', sheet_id: 't_people', view_id: 'v_widths',
      patch: { widths: { f_title: 299 } } },
  ]);
  assert.equal(applied.actions[0].status, 'verified');
  assert.deepEqual(applied.actions[0].differences, []);
});

test('核对：11 视图隐藏列乱序与局部列宽补丁从误报 pending 恢复为 verified', () => {
  const names = ['任务总览一', '任务总览二', '任务总览三', '任务总览四', '任务总览五',
    '任务总览六', '任务总览七', '任务总览八', '任务总览九', '任务总览十', '任务总览十一'];
  const views = names.map((name, index) => hiddenView(`v_sample_${index}`, name,
    { widths: { f_title: 120, f_owner: 140, f_count: 0 } }));
  const changes = names.map((_, index) => ({ kind: 'view', action: 'update', sheet_id: 't_people',
    view_id: `v_sample_${index}`, patch: {
      hidden_fields: ['f_title', 'f_owner', 'f_status'],
      widths: { f_title: 120, f_owner: 140 },
    } }));
  const result = verifyChanges(context({ views }), changes);
  assert.equal(result.actions.length, 11);
  assert.equal(result.summary.verified, 11);
  assert.equal(result.summary.pending, 0);
  assert.equal(result.status, 'verified');
});
