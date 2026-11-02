import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields } from '../dist/fields.js';
import { normalizeView, planViewWrite, compareCreateView, encodeViewFilter, encodeViewGroup, encodeViewSort, encodeViewStatistics, buildViewObject } from '../dist/views.js';
import { mutation } from '../dist/mutations.js';

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
    error => error.code === 'UNKNOWN_FIELD');
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
