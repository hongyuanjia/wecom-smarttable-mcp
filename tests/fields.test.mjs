import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields, dependencyCycles, affectedDependents, userFieldMultiple } from '../dist/fields.js';

function rawSchema() {
  return {
    k9: 'f_text',
    k4: [],
    k3: {
      f_text: { k30: '标题', k31: 1, k1: {} },
      f_user_single: { k30: '负责人（成员）', k31: 7, k7: { k1: false, k2: false } },
      f_user_multi: { k30: '协作人员（成员）', k31: 7, k7: { k1: true, k2: true } },
      f_user_multi_no_notify: { k30: '协作人员（不通知）', k31: 7, k7: { k1: true, k2: false } },
      f_number: { k30: '数量', k31: 2, k2: { k1: 2, k2: true, k9: {} }, k99: 'unparsed' },
      f_date: { k30: '计划完成日期', k31: 4, k4: { k1: 'yyyy-mm-dd', k2: false } },
      f_single: { k30: '执行状态', k31: 17, k17: { k1: false, k2: true, k3: [{ k1: 'o_done', k2: '已完成', k3: 15 }], k9: {} } },
      f_lookup: { k30: '子任务名称（引用）', k31: 20, k20: { k1: 'f_text', k2: 'sheet_target' } },
      f_formula: { k30: '年度事项数', k31: 19, k19: { k1: 'f_number', k2: 'f_text' } },
      f_link: { k30: '关联子任务', k31: 18, k18: { k1: 'sheet_target', k2: true } },
      f_unknown: { k30: '未知类型', k31: 99, k99: { k1: 'f_text' } },
    },
  };
}

test('复杂字段规范化：成员单/多选、数字、日期、选项、派生引用与未知类型分别声明支持程度', () => {
  const schema = schemaFromRaw(rawSchema());
  const fields = normalizeFields(schema, ['sheet_target']);
  const byId = Object.fromEntries(fields.map(field => [field.id, field]));

  assert.equal(byId.f_user_single.type, 'USER');
  assert.deepEqual(byId.f_user_single.attributes, {
    kind: 'USER', multiple: false, notify_when_added: false, raw_flags: { k1: false, k2: false }, semantics: 'verified',
  });
  assert.equal(byId.f_user_single.attribute_status, 'verified');
  assert.equal(userFieldMultiple(byId.f_user_multi), true);
  assert.equal(byId.f_user_multi_no_notify.attributes.multiple, true);
  assert.equal(byId.f_user_multi_no_notify.attributes.notify_when_added, false);
  assert.equal(byId.f_user_multi.support.write_cell, 'verified');
  assert.equal(byId.f_user_single.config_digest.length, 64);

  assert.equal(byId.f_number.attributes.decimal_places, 2);
  assert.equal(byId.f_number.attributes.use_separator, true);
  assert.ok(byId.f_number.unparsed_attribute_keys.includes('k99'));

  assert.equal(byId.f_date.attributes.format, 'yyyy-mm-dd');
  assert.equal(byId.f_date.attributes.auto_fill, false);

  assert.equal(byId.f_single.attributes.kind, 'SELECT');
  assert.equal(byId.f_single.attributes.multiple, false);
  assert.deepEqual(byId.f_single.options, [{ id: 'o_done', name: '已完成', style: 15 }]);

  assert.equal(byId.f_lookup.origin, 'derived');
  assert.equal(byId.f_lookup.attribute_status, 'verified');
  assert.deepEqual(byId.f_lookup.dependencies, ['f_text']);
  assert.deepEqual(byId.f_lookup.target_sheet_ids, ['sheet_target']);
  assert.equal(byId.f_lookup.support.write_config, 'verified');

  assert.equal(byId.f_formula.origin, 'derived');
  assert.equal(byId.f_formula.attribute_status, 'verified');
  assert.equal(byId.f_formula.support.write_config, 'verified');
  assert.deepEqual(byId.f_formula.dependencies.sort(), ['f_number', 'f_text']);

  assert.equal(byId.f_link.attributes.kind, 'RELATION');
  assert.deepEqual(byId.f_link.target_sheet_ids, ['sheet_target']);

  assert.equal(byId.f_unknown.type, 'UNKNOWN_99');
  assert.equal(byId.f_unknown.support.recognize, 'unsupported');
  assert.equal(byId.f_unknown.origin, 'unknown');
  assert.equal(byId.f_unknown.writable_cell, false);

  assert.equal(byId.f_text.is_primary, true);
  assert.equal(byId.f_text.origin, 'business');
});

test('依赖环与受影响字段：只依据可识别引用，返回路径而不是静默忽略', () => {
  const fields = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c', dependencies: ['a'] },
    { id: 'd', dependencies: ['a'] },
  ];
  const cycles = dependencyCycles(fields);
  assert.equal(cycles.length >= 1, true);
  assert.deepEqual(cycles[0].slice(0, 3).sort(), ['a', 'b', 'c']);
  assert.deepEqual(affectedDependents(fields, ['a']).sort(), ['b', 'c', 'd']);
});
