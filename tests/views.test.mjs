import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields } from '../dist/fields.js';
import { normalizeView, planViewWrite, compareCreateView, encodeViewFilter, encodeViewGroup, encodeViewSort, encodeViewStatistics, buildViewObject, viewStatisticsMatches } from '../dist/views.js';
import { compareHiddenFieldSets, compareProtectedWidths, compareRequestedWidths, mergeWidths } from '../dist/view-semantics.js';
import { mutation } from '../dist/mutations.js';
import { WecomWriter } from '../dist/writer.js';

const rawFields = {
  k9: 'f_text',
  k4: [],
  k3: {
    f_text: { k30: '事项名称', k31: 1 },
    f_user: { k30: '承担人员（成员）', k31: 7, k7: { k1: false, k2: false } },
    f_status: { k30: '执行状态', k31: 17, k17: { k1: false, k2: true, k3: [{ k1: 'o_done', k2: '已完成', k3: 15 }] } },
    f_task: { k30: '所属任务编号', k31: 1 },
  },
};
const fields = normalizeFields(schemaFromRaw(rawFields));

function wideTable(count) {
  const names = Array.from({ length: count }, (_, index) => `f${String(index + 1).padStart(2, '0')}`);
  return {
    names,
    fields: normalizeFields(schemaFromRaw({
      k9: names[0],
      k4: [],
      k3: Object.fromEntries(names.map((id, index) => [id, { k30: `字段 ${index + 1}`, k31: 1 }])),
    })),
  };
}

function rawView(overrides = {}) {
  return {
    k30: 'v_mine', k31: '我的职责', k32: 1, k33: 0, k34: 'owner_example', k35: 1, k37: [], k38: {},
    k1: {
      k1: [], k2: ['f_text', 'f_user', 'f_status'], k3: 1, k4: 1,
      k5: { f_text: { k1: 280, k2: false, k3: 0, k4: 0 }, f_user: { k1: 160, k2: false, k3: 0, k4: 0 } },
      k6: true, k7: [{ k1: 'f_status', k2: false }], k8: { k1: 0, k2: [] },
      k9: [{ k1: 'f_text', k2: false }], k10: true, k13: '', k99: 'unparsed',
      ...overrides,
    },
  };
}

test('视图规范化：列顺序、隐藏列、列宽、分组、排序、筛选与未知设置分别保留', () => {
  const view = normalizeView(rawView({ k8: { k1: 0, k2: [{ k30: 'f_user', k31: 7, k32: 3, k7: [{ k1: 'u_example', k2: '甲' }] }] } }), fields);
  assert.equal(view.id, 'v_mine');
  assert.equal(view.name, '我的职责');
  assert.equal(view.type, 'grid');
  assert.equal(view.type_verified, true);
  assert.deepEqual(view.columns, ['f_text', 'f_user', 'f_status']);
  assert.deepEqual(view.hidden_fields, ['f_task']);
  assert.equal(view.widths.f_text, 280);
  assert.deepEqual(view.group, [{ field_id: 'f_status', field_name: '执行状态', descending: false }]);
  assert.deepEqual(view.sort, [{ field_id: 'f_text', field_name: '事项名称', descending: false }]);
  assert.equal(view.filter.present, true);
  assert.equal(view.filter.conjunction, 'and');
  assert.equal(view.filter.conditions[0].field_name, '承担人员（成员）');
  assert.equal(view.filter.conditions[0].operator, null);
  assert.equal(view.filter.conditions[0].operator_code, 3);
  assert.equal(view.filter.comparable, false);
  assert.equal(view.statistics_enabled, true);
  assert.equal(view.auto_sort, true);
  assert.deepEqual(view.unknown_settings, ['k99']);
  assert.equal(view.viewer_dependent, false);
  assert.equal(view.dynamic_viewer.supported, true);
  assert.equal(view.raw_digest.length, 64);
  assert.equal(view.config_digest.length, 64);
});

test('直接创建同名视图复用配置比较：相同跳过、不同给差异、多个要求 ID', () => {
  const patch = { name: '我的职责', type: 'grid',
    field_order: ['f_text', 'f_user', 'f_status'],
    widths: { f_text: 280, f_user: 160, f_status: 140 },
    group: [{ field_id: 'f_status' }], sort: [{ field_id: 'f_text' }], statistics: false };
  const existingRaw = () => ({
    k30: 'v_same', k31: '我的职责', k32: 1, k33: 2, k34: 'owner_example', k35: 1,
    k1: {
      k1: [], k2: ['f_text', 'f_user', 'f_status'], k3: 1, k4: 1,
      k5: { f_text: { k1: 280, k2: false }, f_user: { k1: 160, k2: false }, f_status: { k1: 140, k2: false } },
      k6: true, k7: [{ k1: 'f_status', k2: false }], k8: null,
      k9: [{ k1: 'f_text', k2: false }], k10: false, k13: '',
    },
  });
  const existing = normalizeView(existingRaw(), fields);

  const same = compareCreateView({ patch, views: [existing], fields });
  assert.equal(same.decision, 'skip');
  assert.equal(same.view_id, 'v_same');
  assert.deepEqual(same.differences, []);
  assert.equal(planViewWrite({ action: 'create', patch, views: [existing], fields }).decision, 'skip');

  const different = compareCreateView({ patch: { ...patch, sort: [{ field_id: 'f_user' }] }, views: [existing], fields });
  assert.equal(different.decision, 'conflict');
  assert.ok(different.differences.some(item => item.path === 'sort'));

  const other = normalizeView({ ...existingRaw(), k30: 'v_other' }, fields);
  assert.throws(() => compareCreateView({ patch, views: [existing, other], fields }),
    error => error.code === 'VIEW_AMBIGUOUS');
  assert.equal(compareCreateView({ patch: { ...patch, name: '新视图' }, views: [existing], fields }), null);
});

test('直接创建同名视图比较统计标志：请求 true 与已有 true 跳过，与已有 false 冲突', () => {
  const patch = { name: '我的职责', type: 'grid',
    field_order: ['f_text', 'f_user', 'f_status'],
    widths: { f_text: 280, f_user: 160, f_status: 140 },
    group: [{ field_id: 'f_status' }], sort: [{ field_id: 'f_text' }], statistics: true };
  const existingRaw = statistics => ({
    k30: 'v_stats', k31: '我的职责', k32: 1, k33: 2, k34: 'owner_example', k35: 1,
    k1: {
      k1: [], k2: ['f_text', 'f_user', 'f_status'], k3: 1, k4: 1,
      k5: { f_text: { k1: 280, k2: false }, f_user: { k1: 160, k2: false }, f_status: { k1: 140, k2: false } },
      k6: true, k7: [{ k1: 'f_status', k2: false }], k8: null,
      k9: [{ k1: 'f_text', k2: false }], k10: statistics, k13: '',
    },
  });

  const same = compareCreateView({ patch, views: [normalizeView(existingRaw(true), fields)], fields });
  assert.equal(same.decision, 'skip');
  assert.deepEqual(same.differences, []);

  const conflict = compareCreateView({ patch, views: [normalizeView(existingRaw(false), fields)], fields });
  assert.equal(conflict.decision, 'conflict');
  assert.deepEqual(conflict.differences, [{ path: 'statistics', before: false, after: true }]);
});

test('同名视图比较：已有空筛选条件与未设置筛选等价', () => {
  const patch = { name: '我的职责', type: 'grid',
    field_order: ['f_text', 'f_user', 'f_status'],
    widths: { f_text: 280, f_user: 160, f_status: 140 },
    group: [{ field_id: 'f_status' }], sort: [{ field_id: 'f_text' }], statistics: false };
  const existing = normalizeView({
    k30: 'v_empty_filter', k31: '我的职责', k32: 1, k33: 2, k34: 'owner_example', k35: 1,
    k1: {
      k1: [], k2: ['f_text', 'f_user', 'f_status'], k3: 1, k4: 1,
      k5: { f_text: { k1: 280, k2: false }, f_user: { k1: 160, k2: false }, f_status: { k1: 140, k2: false } },
      k6: true, k7: [{ k1: 'f_status', k2: false }], k8: { k1: 1, k2: [] },
      k9: [{ k1: 'f_text', k2: false }], k10: false, k13: '',
    },
  }, fields);
  assert.equal(existing.filter.present, true);
  assert.deepEqual(existing.filter.conditions, []);

  const comparison = compareCreateView({ patch, views: [existing], fields });
  assert.equal(comparison.decision, 'skip');
  assert.deepEqual(comparison.differences, []);
});

test('统计校验只看 k10，不因同次调用修改其他视图设置而失败', () => {
  const changed = { ...rawView({ k10: true }), k31: '同步改名' };
  changed.k1 = { ...changed.k1, k4: 2, k8: { k1: 1, k2: [{ k30: 'f_text', k31: 1, k32: 3, k1: '区县' }] } };
  assert.equal(viewStatisticsMatches(changed, true), true);
  assert.equal(viewStatisticsMatches(changed, false), false);
  assert.equal(viewStatisticsMatches({ ...changed, k1: { ...changed.k1, k10: false } }, false), true);
});

test('同名校验：唯一且无差异跳过，同名不同配置给差异，多个同名必须用 ID', () => {
  const existing = normalizeView(rawView(), fields);
  const skip = planViewWrite({ action: 'create', patch: { name: '我的职责' }, views: [existing], fields });
  assert.equal(skip.decision, 'conflict'); // 新建同名视图应显式冲突，不能自动覆盖

  const updateSkip = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { name: '我的职责' }, views: [existing], fields });
  assert.equal(updateSkip.decision, 'skip');
  assert.equal(updateSkip.differences.length, 0);

  const rename = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { name: '按人员查看' }, views: [existing], fields });
  assert.equal(rename.decision, 'update');
  assert.deepEqual(rename.differences[0], { path: 'name', before: '我的职责', after: '按人员查看' });

  const second = normalizeView({ ...rawView(), k30: 'v_other', k31: '我的职责' }, fields);
  assert.throws(() => planViewWrite({ action: 'create', patch: { name: '我的职责' }, views: [existing, second], fields }),
    error => error.code === 'VIEW_AMBIGUOUS');

  const renamed = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { name: '已有视图' },
    views: [existing, normalizeView({ ...rawView(), k30: 'v_taken', k31: '已有视图' }, fields)], fields });
  assert.equal(renamed.decision, 'conflict');
  assert.ok(renamed.notes.some(note => note.includes('v_taken')));
});

test('补丁语义：省略保持、null 清除、空条件拒绝，动态“我”可编码', () => {
  const existing = normalizeView(rawView({ k8: { k1: 0, k2: [{ k30: 'f_status', k31: 17, k32: 1, k17: ['o_done'] }] } }), fields);
  const rename = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { name: '新名称' }, views: [existing], fields });
  assert.equal(rename.differences.some(item => item.path === 'filter'), false);

  const clear = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { filter: null }, views: [existing], fields });
  assert.equal(clear.differences.some(item => item.path === 'filter'), true);
  assert.equal(clear.effective.filter, null);

  assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine', patch: { filter: { conjunction: 'and', conditions: [] } }, views: [existing], fields }),
    error => error.code === 'INVALID_ARGUMENT');

  const dynamic = planViewWrite({ action: 'create', patch: { name: '我的职责', filter: { conjunction: 'and',
    conditions: [{ field_id: 'f_user', operator: 'contains', value_kind: 'current_viewer' }] } }, views: [], fields });
  assert.equal(dynamic.decision, 'create');
  assert.equal(dynamic.effective.filter.conditions[0].value_kind, 'current_viewer');
  assert.throws(() => planViewWrite({ action: 'create', patch: { name: '错误动态', filter: { conjunction: 'and',
    conditions: [{ field_id: 'f_text', operator: 'contains', value_kind: 'current_viewer' }] } }, views: [], fields }),
  error => error.code === 'INVALID_ARGUMENT');
});

test('视图统计标志：3025 mutation 形状固定，null 归一化为关闭', () => {
  // 抓包帧：[[{"t":3025,"v":5,"c":{"1":"s_test","2":"v_test","3":{"1":true}},"r":29,"o":0}]]
  // r 由提交信封填充；本地 mutation 统一使用 -1 占位。
  assert.deepEqual(mutation(3025, { '1': 's_test', '2': 'v_test', '3': encodeViewStatistics(true) }),
    { t: 3025, v: 5, c: { '1': 's_test', '2': 'v_test', '3': { '1': true } }, r: -1, o: 0 });
  assert.deepEqual(encodeViewStatistics(false), { '1': false });
  // k10 只有布尔状态；null 不能写回，统一解释为关闭。
  assert.deepEqual(encodeViewStatistics(null), { '1': false });

  const existingOn = normalizeView(rawView(), fields);
  const disable = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { statistics: null }, views: [existingOn], fields });
  assert.equal(disable.decision, 'update');
  assert.equal(disable.effective.statistics, false);
  assert.deepEqual(disable.differences, [{ path: 'statistics', before: true, after: false }]);

  const existingOff = normalizeView(rawView({ k10: false }), fields);
  const noop = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { statistics: null }, views: [existingOff], fields });
  assert.equal(noop.decision, 'skip');
  assert.deepEqual(noop.differences, []);
});

test('视图统计标志改变只影响 statistics_enabled，其余配置摘要保持稳定', () => {
  const enabled = normalizeView(rawView({ k10: true }), fields);
  const disabled = normalizeView(rawView({ k10: false }), fields);
  assert.equal(enabled.statistics_enabled, true);
  assert.equal(disabled.statistics_enabled, false);
  assert.notEqual(enabled.config_digest, disabled.config_digest);
  const configWithoutStatistics = ({ config_digest: _digest, raw_digest: _raw, statistics_enabled: _statistics, ...rest }) => rest;
  for (const key of Object.keys(configWithoutStatistics(enabled))) {
    assert.deepEqual(configWithoutStatistics(disabled)[key], configWithoutStatistics(enabled)[key], key);
  }
});

test('视图配置校验：未知字段、重复字段、列宽越界和不完整列顺序均拒绝', () => {
  const existing = normalizeView(rawView(), fields);
  for (const patch of [
    { group: [{ field_id: 'f_missing' }] },
    { sort: [{ field_id: 'f_text' }, { field_id: 'f_text' }] },
    { widths: { f_text: 0 } },
    { field_order: ['f_text'] },
    { hidden_fields: ['f_missing'] },
  ]) {
    assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine', patch, views: [existing], fields }),
      error => ['UNKNOWN_FIELD', 'INVALID_ARGUMENT'].includes(error.code), JSON.stringify(patch));
  }
});

test('看板计划必须保留未填状态记录并校验分组/卡片字段', () => {
  const existing = normalizeView(rawView(), fields);
  const plan = planViewWrite({ action: 'update', view_id: 'v_mine', patch: { kanban: {
    group_field_id: 'f_status', card_fields: ['f_text', 'f_user'], retains_empty_group: true } }, views: [existing], fields });
  assert.equal(plan.decision, 'update');
  assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine', patch: { kanban: {
    group_field_id: 'f_status', card_fields: ['f_text'], retains_empty_group: false } }, views: [existing], fields }),
  error => error.code === 'INVALID_ARGUMENT');
});

test('视图写入编码：分组/排序保持顺序，筛选区分文本、单选与动态“我”', () => {
  assert.deepEqual(encodeViewGroup([{ field_id: 'f_status', descending: true }]), [{ '1': 'f_status', '2': true }]);
  assert.deepEqual(encodeViewSort([{ field_id: 'f_text' }, { field_id: 'f_user', descending: true }]),
    [{ '1': 'f_text', '2': false }, { '1': 'f_user', '2': true }]);

  assert.deepEqual(encodeViewFilter({ conjunction: 'and', conditions: [
    { field_id: 'f_text', operator: 'contains', value: '区县' },
  ] }, fields), { '1': 1, '2': [{ '1': '区县', '30': 'f_text', '31': 1, '32': 3, '33': 0, '35': false }] });

  assert.deepEqual(encodeViewFilter({ conjunction: 'or', conditions: [
    { field_id: 'f_status', operator: 'eq', value: 'o_done' },
  ] }, fields), { '1': 2, '2': [{ '17': ['o_done'], '30': 'f_status', '31': 17, '32': 1, '33': 0, '35': false }] });

  assert.deepEqual(encodeViewFilter({ conjunction: 'and', conditions: [
    { field_id: 'f_user', operator: 'contains', value_kind: 'current_viewer' },
  ] }, fields), { '1': 1, '2': [{ '30': 'f_user', '31': 7, '32': 3, '33': 0, '35': true }] });

  assert.throws(() => encodeViewFilter({ conjunction: 'and', conditions: [
    { field_id: 'f_text', operator: 'contains', value_kind: 'current_viewer' },
  ] }, fields), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => encodeViewFilter({ conjunction: 'and', conditions: [
    { field_id: 'f_status', operator: 'eq', value: 'o_unknown' },
  ] }, fields), error => error.code === 'UNKNOWN_OPTION');
  assert.throws(() => encodeViewFilter({ conjunction: 'and', conditions: [] }, fields), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(encodeViewFilter(null, fields), null);
});

test('视图对象：可见字段顺序、动态“我”、看板分组与卡片字段', () => {
  const base = {
    viewId: 'v_test', name: '按人员查看', type: 'grid', actorUid: 'owner_example',
    recordIds: ['r1', 'r2'], fields,
  };
  const grid = buildViewObject({ ...base, patch: {
    field_order: ['f_user', 'f_status'], widths: { f_user: 200 },
    group: [{ field_id: 'f_user' }], sort: [{ field_id: 'f_text' }],
  } });
  assert.deepEqual(grid['1']['2'], ['f_user', 'f_status']);
  assert.equal(grid['1']['5'].f_user['1'], 200);
  assert.equal(grid['1']['5'].f_status['1'], 140);
  assert.deepEqual(grid['1']['7'], [{ '1': 'f_user', '2': false }]);
  assert.deepEqual(grid['1']['9'], [{ '1': 'f_text', '2': false }]);
  assert.equal(grid['30'], 'v_test');
  assert.equal(grid['32'], 1);

  const dynamic = buildViewObject({ ...base, patch: { filter: { conjunction: 'and', conditions: [
    { field_id: 'f_user', operator: 'contains', value_kind: 'current_viewer' },
  ] } } });
  assert.deepEqual(dynamic['1']['8'], { '1': 1, '2': [{ '30': 'f_user', '31': 7, '32': 3, '33': 0, '35': true }] });

  const kanban = buildViewObject({ ...base, type: 'kanban', patch: {
    kanban: { group_field_id: 'f_status', card_fields: ['f_text', 'f_user'], retains_empty_group: true },
  } });
  assert.equal(kanban['32'], 2);
  assert.deepEqual(kanban['1']['2'], ['f_text', 'f_user']);
  assert.deepEqual(kanban['1']['7'], [{ '1': 'f_status', '2': false }]);

  assert.throws(() => buildViewObject({ ...base, patch: { field_order: ['f_text', 'f_text'] } }),
    error => error.code === 'INVALID_ARGUMENT' && /重复/.test(error.message));
});

test('隐藏列从宽度配置 k5.k2 解析，并提供可见列集合', () => {
  const raw = rawView({ k5: {
    f_text: { k1: 280, k2: true, k3: 0, k4: 0 },
    f_user: { k1: 160, k2: false, k3: 0, k4: 0 },
    f_status: { k1: 120, k2: false, k3: 0, k4: 0 },
  } });
  const view = normalizeView(raw, fields);
  assert.deepEqual(view.hidden_fields, ['f_text']);
  assert.equal(view.hidden_fields_source, 'width_flags');
  assert.deepEqual(view.visible_columns, ['f_user', 'f_status']);
  assert.deepEqual(view.columns, ['f_text', 'f_user', 'f_status']);
});


test('视图范围：k35 映射公共/锁定/个人，创建时写入对应级别', () => {
  assert.equal(normalizeView({ ...rawView(), k35: 1 }, fields).scope, 'shared');
  assert.equal(normalizeView({ ...rawView(), k35: 2 }, fields).scope, 'locked');
  assert.equal(normalizeView({ ...rawView(), k35: 3 }, fields).scope, 'personal');
  const personal = buildViewObject({ viewId: 'v_personal', name: '个人', type: 'grid', actorUid: 'u_owner',
    recordIds: [], fields, patch: { name: '个人', scope: 'personal' } });
  assert.equal(personal['35'], 3);
  const locked = buildViewObject({ viewId: 'v_locked', name: '锁定', type: 'grid', actorUid: 'u_owner',
    recordIds: [], fields, patch: { name: '锁定', scope: 'locked' } });
  assert.equal(locked['35'], 2);
});


test('视图可编辑性：锁定不可改，个人仅 owner 可改，共享按文档权限', () => {
  assert.equal(normalizeView({ ...rawView(), k35: 2 }, fields, undefined, 'owner_example').editable, false);
  assert.equal(normalizeView({ ...rawView(), k35: 3 }, fields, undefined, 'owner_example').editable, true);
  assert.equal(normalizeView({ ...rawView(), k35: 3 }, fields, undefined, 'other_user').editable, false);
  assert.equal(normalizeView({ ...rawView(), k35: 1 }, fields, undefined, 'other_user').editable, true);
});

test('隐藏列按集合比较：乱序跳过，缺少/多出报告具体路径，省略保留，显式空数组清空', () => {
  const allColumns = ['f_text', 'f_user', 'f_status', 'f_task'];
  const existing = normalizeView(rawView({
    k1: ['f_text', 'f_task'],
    k2: allColumns,
    k5: {
      f_text: { k1: 280, k2: true }, f_user: { k1: 160, k2: false },
      f_status: { k1: 140, k2: false }, f_task: { k1: 120, k2: true },
    },
  }), fields);
  assert.deepEqual(existing.hidden_fields, ['f_text', 'f_task']);

  const reordered = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { hidden_fields: ['f_task', 'f_text'] }, views: [existing], fields });
  assert.equal(reordered.decision, 'skip');
  assert.deepEqual(reordered.differences, []);

  const missing = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { hidden_fields: ['f_text'] }, views: [existing], fields });
  assert.equal(missing.decision, 'update');
  assert.deepEqual(missing.differences, [{ path: 'hidden_fields.extra.f_task', before: true, after: false }]);

  const extra = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { hidden_fields: ['f_text', 'f_task', 'f_user'] }, views: [existing], fields });
  assert.equal(extra.decision, 'update');
  assert.deepEqual(extra.differences, [{ path: 'hidden_fields.missing.f_user', before: false, after: true }]);

  const omitted = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { name: '我的职责' }, views: [existing], fields });
  assert.equal(omitted.decision, 'skip');
  assert.deepEqual(omitted.effective.hidden_fields, ['f_text', 'f_task']);

  const cleared = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { hidden_fields: [] }, views: [existing], fields });
  assert.equal(cleared.decision, 'update');
  assert.deepEqual(cleared.differences, [
    { path: 'hidden_fields.extra.f_task', before: true, after: false },
    { path: 'hidden_fields.extra.f_text', before: true, after: false },
  ]);

  assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { hidden_fields: ['f_text', 'f_text'] }, views: [existing], fields }),
  error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => planViewWrite({ action: 'create', patch: { name: '我的职责', hidden_fields: ['f_text', 'f_text'] },
    views: [existing], fields }), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => planViewWrite({ action: 'create', patch: { name: '我的职责', widths: { f_text: 0 } },
    views: [existing], fields }), error => error.code === 'INVALID_ARGUMENT');
});

test('列宽按补丁合并：只核验请求键，未请求键保留，空对象和重复补丁无差异', () => {
  const existing = normalizeView(rawView({ k5: {
    f_text: { k1: 120, k2: false }, f_user: { k1: 140, k2: false },
    f_status: { k1: 0, k2: true },
  } }), fields);

  const plan = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { widths: { f_text: 300 } }, views: [existing], fields });
  assert.equal(plan.decision, 'update');
  assert.deepEqual(plan.effective.widths, { f_text: 300, f_user: 140, f_status: 0 });
  assert.deepEqual(plan.differences, [{ path: 'widths.f_text', before: 120, after: 300 }]);

  const repeated = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { widths: { f_text: 120 } }, views: [existing], fields });
  assert.equal(repeated.decision, 'skip');
  assert.deepEqual(repeated.differences, []);
  assert.deepEqual(repeated.effective.widths, { f_text: 120, f_user: 140, f_status: 0 });

  const empty = planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { widths: {} }, views: [existing], fields });
  assert.equal(empty.decision, 'skip');
  assert.deepEqual(empty.differences, []);

  for (const width of [0, -1, 1001, 140.5]) {
    assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine',
      patch: { widths: { f_text: width } }, views: [existing], fields }),
    error => error.code === 'INVALID_ARGUMENT', String(width));
  }
  assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { widths: { f_missing: 140 } }, views: [existing], fields }),
  error => error.code === 'UNKNOWN_FIELD');
});

test('分组和排序仍按顺序比较，不套用隐藏列集合语义', () => {
  const existing = normalizeView(rawView({ k7: [{ k1: 'f_status', k2: false }, { k1: 'f_user', k2: true }],
    k9: [{ k1: 'f_text', k2: false }] }), fields);
  const reordered = planViewWrite({ action: 'update', view_id: 'v_mine', patch: {
    group: [{ field_id: 'f_user', descending: true }, { field_id: 'f_status', descending: false }],
  }, views: [existing], fields });
  assert.equal(reordered.decision, 'update');
  assert.ok(reordered.differences.some(item => item.path === 'group'));

  const same = planViewWrite({ action: 'update', view_id: 'v_mine', patch: {
    group: [{ field_id: 'f_status' }, { field_id: 'f_user', descending: true }],
    sort: [{ field_id: 'f_text' }],
  }, views: [existing], fields });
  assert.equal(same.decision, 'skip');
});

test('共享语义层：宽度合并、请求键与受保护键分别比较，隐藏集合给出具体路径', () => {
  assert.deepEqual(mergeWidths({ A: 120, B: 140, H: 0 }, { A: 300 }), { A: 300, B: 140, H: 0 });
  assert.deepEqual(compareRequestedWidths({ A: 299, B: 140 }, { A: 300 }), [
    { path: 'widths.A', before: 299, after: 300 },
  ]);
  assert.deepEqual(compareRequestedWidths({ A: 300, B: 140 }, { A: 300 }), []);
  assert.deepEqual(compareProtectedWidths({ A: 120, B: 140, H: 0 }, { A: 300, B: 140, H: 0 }, ['A']), []);
  assert.deepEqual(compareProtectedWidths({ A: 120, B: 140, H: 0 }, { A: 300, B: 999, H: 0 }, ['A']), [
    { path: 'widths.B', before: 140, after: 999 },
  ]);
  assert.deepEqual(compareHiddenFieldSets(['f_user', 'f_text'], ['f_text', 'f_user']), []);
  assert.deepEqual(compareHiddenFieldSets(['f_text'], ['f_text', 'f_user']), [
    { path: 'hidden_fields.missing.f_user', before: false, after: true },
  ]);
});

test('更新视图列顺序：29 字段表/16 列视图只重排当前列（含隐藏列），不按全表补齐', () => {
  const { names, fields: wideFields } = wideTable(29);
  const columns = names.slice(0, 16);
  const hidden = ['f04', 'f06', 'f08', 'f10', 'f12', 'f14'];
  const wideView = normalizeView({
    k30: 'v_wide', k31: '按人员查看', k32: 1, k33: 0, k34: 'owner_example', k35: 1, k37: [], k38: {},
    k1: {
      k1: hidden, k2: columns, k3: 1, k4: 1,
      k5: Object.fromEntries(columns.map((id, index) => [id, { k1: 120 + index, k2: hidden.includes(id), k3: 0, k4: 0 }])),
      k6: true, k7: [{ k1: 'f02', k2: false }],
      k8: { k1: 1, k2: [{ k30: 'f03', k31: 1, k32: 1, k33: 0 }] },
      k9: [{ k1: 'f01', k2: false }], k10: true, k13: '',
    },
  }, wideFields);
  assert.equal(wideView.columns.length, 16);
  assert.equal(wideView.hidden_fields.length, 6);

  const reversed = [...columns].reverse();
  const reordered = planViewWrite({ action: 'update', view_id: 'v_wide',
    patch: { field_order: reversed }, views: [wideView], fields: wideFields });
  assert.equal(reordered.decision, 'update');
  assert.deepEqual(reordered.differences, [{ path: 'columns', before: columns, after: reversed }]);
  assert.deepEqual(reordered.effective.columns, reversed);
  // 仅换序：不加入视图外的 13 个字段，隐藏状态、分组、排序、筛选保持原值。
  assert.equal(reordered.effective.columns.some(id => names.slice(16).includes(id)), false);
  assert.deepEqual(reordered.effective.hidden_fields, wideView.hidden_fields);
  assert.deepEqual(reordered.effective.group, [{ field_id: 'f02', descending: false }]);
  assert.deepEqual(reordered.effective.sort, [{ field_id: 'f01', descending: false }]);
  assert.deepEqual(reordered.effective.filter, wideView.filter && { present: true });

  // 正确顺序重复提交无差异、不产生写入。
  const repeated = planViewWrite({ action: 'update', view_id: 'v_wide',
    patch: { field_order: columns }, views: [wideView], fields: wideFields });
  assert.equal(repeated.decision, 'skip');
  assert.deepEqual(repeated.differences, []);
});

test('更新视图列顺序校验：29 列替换 16 列、重复、未知、遗漏与混入其他表均拒绝并带当前列信息', () => {
  const { names, fields: wideFields } = wideTable(29);
  const columns = names.slice(0, 16);
  const wideView = normalizeView({
    k30: 'v_wide', k31: '按人员查看', k32: 1, k33: 0, k34: 'owner_example', k35: 1, k37: [], k38: {},
    k1: { k1: [], k2: columns, k3: 1, k4: 1,
      k5: Object.fromEntries(columns.map((id, index) => [id, { k1: 120 + index, k2: false }])),
      k6: true, k7: [], k8: { k1: 0, k2: [] }, k9: [], k10: true, k13: '' },
  }, wideFields);
  const update = field_order => planViewWrite({ action: 'update', view_id: 'v_wide',
    patch: { field_order }, views: [wideView], fields: wideFields });

  assert.throws(() => update(names), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(error.details.current_columns, columns);
    assert.equal(error.details.current_column_count, 16);
    assert.equal(error.details.submitted_column_count, 29);
    assert.deepEqual(error.details.extra_columns, names.slice(16));
    assert.deepEqual(error.details.missing_columns, []);
    return true;
  });
  assert.throws(() => update([...columns, 'f01']),
    error => error.code === 'INVALID_ARGUMENT' && /重复/.test(error.message));
  assert.throws(() => update([...columns.slice(1), 'f_other_table']),
    error => error.code === 'UNKNOWN_FIELD' && error.details.field_id === 'f_other_table');
  assert.throws(() => update(columns.slice(1)), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(error.details.missing_columns, [columns[0]]);
    return true;
  });
});

test('新建视图字段选择与更新列顺序契约分开：新建可选子集，更新必须覆盖当前列', () => {
  const subset = ['f_text', 'f_user'];
  const created = planViewWrite({ action: 'create', patch: { name: '部分字段视图', field_order: subset },
    views: [], fields });
  assert.equal(created.decision, 'create');
  assert.deepEqual(created.effective.columns, subset);

  const existing = normalizeView(rawView(), fields);
  assert.throws(() => planViewWrite({ action: 'update', view_id: 'v_mine',
    patch: { field_order: subset }, views: [existing], fields }), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(error.details.missing_columns, ['f_status']);
    return true;
  });
});

test('执行器复用更新列顺序契约：正确排列不写入，29 列替换/重复/遗漏在提交前拒绝且零写入', async () => {
  const { names, fields: wideFields } = wideTable(29);
  const columns = names.slice(0, 16);
  const hidden = ['f04', 'f06', 'f08'];
  const rawViewData = {
    k30: 'v_wide', k31: '按人员查看', k32: 1, k33: 0, k34: 'owner_example', k35: 1, k37: [], k38: {},
    k1: {
      k1: hidden, k2: columns, k3: 1, k4: 1,
      k5: Object.fromEntries(columns.map((id, index) => [id, { k1: 120 + index, k2: hidden.includes(id) }])),
      k6: true, k7: [], k8: { k1: 0, k2: [] }, k9: [], k10: false, k13: '',
    },
  };
  const rawSchema = {
    k9: names[0], k4: [rawViewData],
    k3: Object.fromEntries(names.map((id, index) => [id, { k30: `字段 ${index + 1}`, k31: 1 }])),
  };
  const schema = schemaFromRaw(rawSchema);
  const chunk = { revision: 7, sheetId: 't_wide', records: [], total: 0, start: 0, end: 0, schema };
  const posts = [];
  const client = {
    context: { post: async (...args) => { posts.push(args); throw new Error('unexpected write'); }, dispose: async () => {} },
    cookie: () => 'token_example',
    openDocument: async () => ({
      doc: { id: 'doc_example' },
      open: { clientVars: {
        privilegeAttribute: { can_edit: 1 },
        collab_client_vars: { dver: 'dver_example', pver: 1 },
        uin: 'u_example', userInfo: { fullName: '示例用户', corp_id: 1 }, optimizedVer: 4,
      } },
      directory: [{ id: 't_wide', type: 'smartsheet' }],
    }),
    chunk: async () => chunk,
    schema: async () => schema,
  };
  const writer = new WecomWriter(client, new AbortController().signal);

  const noop = await writer.updateView('https://doc.example/smartsheet/s3_example', 't_wide', 7, 'v_wide',
    { field_order: columns });
  assert.equal(noop.status, 'verified');
  assert.equal(noop.no_changes, true);
  assert.equal(noop.revision, 7);
  assert.equal(posts.length, 0);

  for (const field_order of [names, [...columns, 'f01'], columns.slice(1), [...columns.slice(1), 'f_other_table']]) {
    await assert.rejects(() => writer.updateView('https://doc.example/smartsheet/s3_example', 't_wide', 7, 'v_wide',
      { field_order }), error => ['INVALID_ARGUMENT', 'UNKNOWN_FIELD'].includes(error.code));
  }
  assert.equal(posts.length, 0, '校验失败不得发出任何写请求');
});
