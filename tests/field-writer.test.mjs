import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields } from '../dist/fields.js';
import { lookupFieldMutations, relationFieldMutations, formulaFieldMutations, formulaFormatter, formulaFormatterMatches } from '../dist/field-writer.js';
import { encodeProviderFormula } from '../dist/formulas.js';

const rawSchema = {
  k9: 'f_title',
  k4: [{ k30: 'v_all', k31: '全部记录', k32: 1, k1: { k1: [], k2: ['f_title', 'f_no', 'f_task'], k3: 1, k4: 1, k5: {}, k6: true, k7: [], k8: { k1: 0, k2: [] }, k9: [], k10: true } }],
  k3: {
    f_title: { k30: '事项名称', k31: 1 },
    f_no: { k30: '事项编号', k31: 1 },
    f_task: { k30: '子任务编号', k31: 1 },
    f_due: { k30: '计划完成日期', k31: 4, k4: { k1: 'yyyy-mm-dd' } },
    f_status: { k30: '执行状态', k31: 17, k17: { k1: false, k2: true, k3: [{ k1: 'o_done', k2: '已完成', k3: 15 }] } },
  },
};
const schema = schemaFromRaw(rawSchema);
const fields = normalizeFields(schema, ['t_people']);

test('查找引用写入：类型 20，目标字段/表、条件与计数统计编码', () => {
  const { field, expected, mutations } = lookupFieldMutations('t_people', schema, '子任务名称（引用）', {
    target_sheet_id: 't_sub', target_field_id: 'f_title', aggregation: 'values',
    conditions: [{ target_field_id: 'f_no', target_field_type: 1, operator_code: 1, local_field_id: 'f_task' }],
  });
  assert.equal(field.type_code, 20);
  assert.equal(mutations[0].t, 3014);
  assert.equal(mutations[0].c['3']['2'], 20);
  assert.deepEqual(mutations[0].c['3']['4'], { v_all: 3 });
  assert.equal(mutations[1].t, 3017);
  assert.equal(expected['20']['5'], 't_sub');
  assert.equal(expected['20']['2'], 'f_title');
  assert.equal(expected['20']['3'], 0);
  const condition = mutations[1].c['4']['20']['6']['2'][0];
  assert.equal(condition['2'], 'f_no');
  assert.equal(condition['5']['2'], 'f_task');
  assert.equal(condition['1'].length, 8);
  assert.ok(mutations.some(mutation => mutation.t === 3024 && mutation.c['2'] === 'v_all'));

  const counted = lookupFieldMutations('t_people', schema, '年度事项数', {
    target_sheet_id: 't_sub', target_field_id: 'f_no', aggregation: 'count',
    conditions: [{ target_field_id: 'f_no', target_field_type: 1, operator_code: 1, local_field_id: 'f_task' }],
  });
  assert.equal(counted.expected['20']['3'], 3);
});

test('关联字段写入：类型 18，目标表与多选标志', () => {
  const { field, mutations } = relationFieldMutations('doc_example', 't_people', schema, '关联子任务', {
    target_sheet_id: 't_sub', multiple: true,
  });
  assert.equal(field.type_code, 18);
  assert.equal(mutations[0].t, 3014);
  assert.equal(mutations[0].c['3']['2'], 18);
  const property = mutations[1].c['4']['18'];
  assert.equal(property['1'], 'doc_example');
  assert.equal(property['2'], 't_sub');
  assert.equal(property['4'], true);
});

test('公式写入：文本片段与字段引用交替，函数使用已验证名称', () => {
  const tokens = encodeProviderFormula({ kind: 'call', name: 'if', args: [
    { kind: 'call', name: 'is_empty', args: [{ kind: 'field', field_id: 'f_due' }] },
    { kind: 'constant', value: '待确定日期' },
    { kind: 'call', name: 'today', args: [] },
  ] }, fields);
  assert.deepEqual(tokens, [
    { '1': 1, '2': 'IF(ISBLANK(' },
    { '1': 2, '3': 'f_due' },
    { '1': 1, '2': '),"待确定日期",TODAY())' },
  ]);
  assert.throws(() => encodeProviderFormula({ kind: 'call', name: 'coalesce', args: [{ kind: 'field', field_id: 'f_due' }] }, fields),
    error => error.code === 'UNSUPPORTED_FORMULA');
  assert.throws(() => encodeProviderFormula({ kind: 'field', field_id: 'f_missing' }, fields),
    error => error.code === 'UNKNOWN_FIELD');

  const { field, mutations } = formulaFieldMutations('t_people', schema, '到期提示', tokens);
  assert.equal(field.type_code, 19);
  assert.equal(mutations[0].c['3']['2'], 19);
  assert.deepEqual(mutations[1].c['4']['19']['1'], tokens);
});


test('双向关联字段：类型 21、预生成反向字段，插入与配置都要求跨表确认', () => {
  const { field, expected, mutations } = relationFieldMutations('doc_example', 't_people', schema, '双向关联', {
    target_sheet_id: 't_sub', multiple: false, two_way: true,
  });
  assert.equal(field.type_code, 21);
  assert.equal(field.type, 'TWO_WAY_LINK_RECORDS');
  assert.equal(field.back_field_id.length, 6);
  assert.equal(mutations[0].c['4'], true);
  assert.equal(mutations[0].c['3']['2'], 21);
  assert.equal(mutations[1].c['6'], true);
  const property = mutations[1].c['4']['21'];
  assert.equal(property['2'], 't_sub');
  assert.equal(property['6'], field.back_field_id);
  assert.equal(property['7'], 1);
  assert.equal(expected['21']['6'], field.back_field_id);
});

test('公式展示格式：数字与百分数按网页端真实编码，比较时转换 k 前缀键', () => {
  const number = formulaFormatter({ type: 'number', decimal_places: 2, use_separator: true });
  assert.deepEqual(number, { '1': 2, '2': { '2': { '1': 2, '2': true, '3': true, '9': {} } } });
  assert.equal(formulaFormatterMatches({ k1: 2, k2: { k2: { k1: 2, k2: true, k3: true, k9: {} } } }, number), true);
  const percent = formulaFormatter({ type: 'percent' });
  assert.deepEqual(percent, { '1': 28, '2': { '28': { '1': -1, '2': false, '3': true, '9': {} } } });
  assert.deepEqual(formulaFormatter({ type: 'date', date_format: 'yyyy-mm-dd' }), { '1': 4, '2': { '4': { '1': 'yyyy-mm-dd', '2': false } } });
  assert.equal(formulaFormatterMatches({ k1: 4, k2: { k4: { k1: 'yyyy-mm-dd', k2: false } } }, formulaFormatter({ type: 'date', date_format: 'yyyy-mm-dd' })), true);
  const tokens = [{ '1': 1, '2': '(1+1)' }];
  const built = formulaFieldMutations('t_people', schema, '格式公式', tokens, number);
  assert.deepEqual(built.expected['19']['2'], number);
});


test('查找引用统计方式：八种真实编码，数值聚合要求数字或进度目标', () => {
  const codes = { values: 0, unique: 1, sum: 2, count: 3, count_unique: 4, average: 5, max: 6, min: 7 };
  for (const [aggregation, code] of Object.entries(codes)) {
    const built = lookupFieldMutations('t_people', schema, `统计_${aggregation}`, {
      target_sheet_id: 't_sub', target_field_id: 'f_no', aggregation,
      conditions: [{ target_field_id: 'f_no', target_field_type: 1, operator_code: 1, local_field_id: 'f_task' }],
    });
    assert.equal(built.expected['20']['3'], code);
  }
});
