import test from 'node:test';
import assert from 'node:assert/strict';
import { dueStatus, completionRate, shanghaiDayKey, todayInShanghai, validateFormulaExpression,
  validateFormulaDefinition, assertFormulaDefinition, assertProviderFormulaSupport, unsupportedProviderCalls,
  evaluateFormula, annualCounts, encodeProviderFormula } from '../dist/formulas.js';

const fields = [
  { id: 'f_status', type: 'SINGLE_SELECT' },
  { id: 'f_due', type: 'DATE_TIME' },
  { id: 'f_count', type: 'NUMBER' },
  { id: 'f_name', type: 'TEXT' },
];

test('到期提示严格按业务伪代码分支：已完成优先于日期和状态', () => {
  const today = '2026-11-02';
  assert.equal(dueStatus({ status: '已完成', due_date: null }, { today }).code, 'COMPLETED');
  assert.equal(dueStatus({ status: '进行中', due_date: null }, { today }).code, 'DATE_PENDING');
  assert.equal(dueStatus({ status: '', due_date: '2026-11-03' }, { today }).code, 'STATUS_PENDING');
  assert.equal(dueStatus({ status: '进行中', due_date: '2026-11-01' }, { today }).code, 'OVERDUE');
  assert.equal(dueStatus({ status: '进行中', due_date: '2026-11-02' }, { today }).code, 'DUE_TODAY');
  assert.equal(dueStatus({ status: '进行中', due_date: '2026-11-03' }, { today }).code, 'NOT_DUE');
  assert.equal(dueStatus({ status: '需协调', due_date: '2026-11-01' }, { today }).label, '已逾期');
});

test('日期按 Asia/Shanghai 自然日比较，午夜边界不随服务器时区漂移', () => {
  assert.equal(shanghaiDayKey('2026-11-02'), '2026-11-02');
  assert.equal(shanghaiDayKey('2026-11-02 00:00:00'), '2026-11-02');
  assert.equal(shanghaiDayKey('2026-11-02T16:30:00.000Z'), '2026-11-03');
  assert.equal(shanghaiDayKey(Date.UTC(2026, 10, 1, 15, 59, 59)), '2026-11-01');
  assert.equal(shanghaiDayKey(Date.UTC(2026, 10, 1, 16, 0, 0)), '2026-11-02');
  assert.equal(todayInShanghai(Date.UTC(2026, 10, 1, 16, 0, 0)), '2026-11-02');
  assert.equal(shanghaiDayKey('not-a-date'), null);
});

test('完成率：分母 0 返回空，不冒充 0% 或 100%', () => {
  assert.deepEqual(completionRate(0, 0).status, 'empty');
  assert.equal(completionRate(0, 0).value, null);
  const normal = completionRate(3, 5);
  assert.equal(normal.value, 0.6);
  assert.equal(normal.display, '60.0%');
  assert.ok(completionRate(6, 5).note.includes('大于'));
});

test('结构化公式校验：未知字段、未知函数、参数数量和类型错误分别报错，不使用 eval', () => {
  const valid = { kind: 'binary', operator: 'add', left: { kind: 'field', field_id: 'f_count' }, right: { kind: 'constant', value: 1 } };
  assert.equal(validateFormulaExpression(valid, fields).status, 'valid');
  assert.equal(validateFormulaExpression({ kind: 'field', field_id: 'f_missing' }, fields).errors[0].code, 'UNKNOWN_FIELD');
  assert.equal(validateFormulaExpression({ kind: 'call', name: 'eval', args: [] }, fields).errors[0].code, 'FORMULA_INVALID');
  assert.equal(validateFormulaExpression({ kind: 'call', name: 'if', args: [{ kind: 'constant', value: true }] }, fields).errors[0].code, 'FORMULA_ARITY');
  const mismatch = validateFormulaExpression({ kind: 'binary', operator: 'add',
    left: { kind: 'field', field_id: 'f_name' }, right: { kind: 'constant', value: 1 } }, fields);
  assert.equal(mismatch.errors[0].code, 'FORMULA_TYPE_MISMATCH');
  const tooDeep = (() => {
    let expression = { kind: 'constant', value: 1 };
    for (let index = 0; index < 25; index += 1) expression = { kind: 'unary', operator: 'negate', operand: expression };
    return expression;
  })();
  assert.ok(validateFormulaExpression(tooDeep, fields).errors.some(error => error.code === 'FORMULA_TOO_DEEP'));
});

test('公式定义区分配置有效与计算状态，声明依赖必须与表达式一致', () => {
  const expression = { kind: 'call', name: 'count_equals', args: [
    { kind: 'field', field_id: 'f_status' }, { kind: 'constant', value: '已完成' }] };
  const result = validateFormulaDefinition({ expression, result_type: 'number', dependencies: ['f_status'] }, fields);
  assert.equal(result.status, 'valid');
  assert.equal(result.config_status, 'valid');
  assert.equal(result.calculation_status, 'unavailable');
  assert.ok(result.calculation_note.includes('不等于'));

  const badDependency = validateFormulaDefinition({ expression, result_type: 'number', dependencies: ['f_count'] }, fields);
  assert.ok(badDependency.errors.some(error => error.code === 'FIELD_DEPENDENCY_CONFLICT'));
});

test('受限解释器只执行结构化节点，可用于本地规则核对', () => {
  assert.equal(evaluateFormula({ kind: 'binary', operator: 'add',
    left: { kind: 'constant', value: 2 }, right: { kind: 'constant', value: 3 } }, {}), 5);
  assert.equal(evaluateFormula({ kind: 'call', name: 'if', args: [
    { kind: 'binary', operator: 'eq', left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 1 } },
    { kind: 'constant', value: '是' }, { kind: 'constant', value: '否' }] }, {}), '是');
  assert.equal(evaluateFormula({ kind: 'call', name: 'count_equals', args: [
    { kind: 'constant', value: ['a', 'b', 'a'] }, { kind: 'constant', value: 'a' }] }, {}), 2);
  assert.equal(evaluateFormula({ kind: 'binary', operator: 'divide',
    left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 0 } }, {}), null);
  assert.equal(evaluateFormula({ kind: 'call', name: 'date_diff_days', args: [
    { kind: 'constant', value: '2026-11-03' }, { kind: 'constant', value: '2026-11-01' }] }, {}), 2);
});

test('年度事项数量与完成数量按来源子任务编号匹配，完成率只统计已完成', () => {
  const records = [
    { source_subtask_number: '2-1', status: '已完成' },
    { source_subtask_number: '2-1', status: '进行中' },
    { source_subtask_number: '2-2', status: '已完成' },
    { source_subtask_number: '2-1', status: '' },
  ];
  const result = annualCounts(records, '2-1');
  assert.equal(result.total, 3);
  assert.equal(result.completed, 1);
  assert.equal(result.rate.value, 1 / 3);
  assert.equal(annualCounts(records, '9-9').total, 0);
  assert.equal(annualCounts(records, '9-9').rate.status, 'empty');
});


test('公式定义校验拒绝自引用和更新后依赖循环，并返回具体错误码', () => {
  const formulaFields = [
    { id: 'f_a', type: 'FORMULA', dependencies: ['f_b'] },
    { id: 'f_b', type: 'FORMULA', dependencies: ['f_a'] },
    { id: 'f_num', type: 'NUMBER', dependencies: [] },
    { id: 'f_name', type: 'TEXT', dependencies: [] },
  ];
  const cycle = validateFormulaDefinition({ expression: { kind: 'field', field_id: 'f_b' }, result_type: 'number' },
    formulaFields, { field_id: 'f_a' });
  assert.ok(cycle.errors.some(error => error.code === 'FIELD_DEPENDENCY_CONFLICT'));

  const selfReference = validateFormulaDefinition({ expression: { kind: 'field', field_id: 'f_a' }, result_type: 'number' },
    formulaFields, { field_id: 'f_a' });
  assert.ok(selfReference.errors.some(error => error.code === 'FIELD_DEPENDENCY_CONFLICT'));

  assert.throws(() => assertFormulaDefinition({ expression: { kind: 'binary', operator: 'add',
    left: { kind: 'field', field_id: 'f_name' }, right: { kind: 'constant', value: 1 } }, result_type: 'number' }, formulaFields),
  error => error.code === 'FORMULA_TYPE_MISMATCH');
  assert.throws(() => assertFormulaDefinition({ expression: { kind: 'call', name: 'not_a_function', args: [] },
    result_type: 'number' }, formulaFields), error => error.code === 'FORMULA_INVALID');
  assert.throws(() => assertFormulaDefinition({ expression: { kind: 'field', field_id: 'f_b' },
    result_type: 'number' }, formulaFields, { field_id: 'f_a' }), error => error.code === 'FIELD_DEPENDENCY_CONFLICT');
});

test('未验证的提供方函数仍在编码前拒绝，不因本地注册表而放宽', () => {
  assert.deepEqual(unsupportedProviderCalls({ kind: 'call', name: 'coalesce', args: [
    { kind: 'constant', value: 1 }, { kind: 'constant', value: 2 }] }), ['coalesce']);
  assert.deepEqual(unsupportedProviderCalls({ kind: 'binary', operator: 'add',
    left: { kind: 'call', name: 'round', args: [{ kind: 'constant', value: 1 }] },
    right: { kind: 'constant', value: 2 } }), []);
});

test('网页公式编码：DATEDIF 补足按天单位，文本 COUNTIF 明确拒绝', () => {
  const tokens = encodeProviderFormula({ kind: 'call', name: 'date_diff_days', args: [
    { kind: 'field', field_id: 'f_due' }, { kind: 'call', name: 'today', args: [] }] },
    [{ id: 'f_due', type: 'DATE_TIME' }, { id: 'f_name', type: 'TEXT' }]);
  assert.deepEqual(tokens, [{ '1': 1, '2': 'DATEDIF(' }, { '1': 2, '3': 'f_due' }, { '1': 1, '2': ',TODAY(),"D")' }]);
  assert.throws(() => encodeProviderFormula({ kind: 'call', name: 'count_equals', args: [
    { kind: 'field', field_id: 'f_name' }, { kind: 'constant', value: '已完成' }] },
  [{ id: 'f_name', type: 'TEXT' }]), error => error.code === 'UNSUPPORTED_FORMULA');
  const invalid = validateFormulaDefinition({ expression: { kind: 'call', name: 'count_equals', args: [
    { kind: 'field', field_id: 'f_name' }, { kind: 'constant', value: '已完成' }] }, result_type: 'number' }, fields);
  assert.ok(invalid.errors.some(error => error.code === 'UNSUPPORTED_FORMULA'));
});

test('COALESCE/PERCENT/文本 COUNTIF 在写入前以 UNSUPPORTED_FORMULA 拒绝并附带服务端错误上下文', () => {
  const coalesce = { expression: { kind: 'call', name: 'coalesce', args: [
    { kind: 'field', field_id: 'f_name' }, { kind: 'constant', value: '未填写' }] }, result_type: 'text' };
  assert.throws(() => assertFormulaDefinition(coalesce, fields), error => {
    assert.equal(error.code, 'UNSUPPORTED_FORMULA');
    const entry = error.details.unsupported.find(item => item.function === 'coalesce');
    assert.equal(entry.provider_name, 'COALESCE');
    assert.equal(entry.provider_error_type, 8);
    assert.equal(entry.provider_error_text, '不识别的内容');
    return true;
  });

  const percent = { expression: { kind: 'call', name: 'percent', args: [
    { kind: 'constant', value: 1 }, { kind: 'constant', value: 2 }] }, result_type: 'number' };
  assert.throws(() => assertFormulaDefinition(percent, fields), error => {
    assert.equal(error.code, 'UNSUPPORTED_FORMULA');
    const entry = error.details.unsupported.find(item => item.function === 'percent');
    assert.equal(entry.provider_name, 'PERCENT');
    assert.equal(entry.provider_error_type, 8);
    assert.equal(entry.provider_error_text, '不识别的内容');
    return true;
  });

  const textCountif = { expression: { kind: 'call', name: 'count_equals', args: [
    { kind: 'field', field_id: 'f_name' }, { kind: 'constant', value: '已完成' }] }, result_type: 'number' };
  assert.throws(() => assertFormulaDefinition(textCountif, fields), error => {
    assert.equal(error.code, 'UNSUPPORTED_FORMULA');
    const entry = error.details.unsupported.find(item => item.function === 'count_equals');
    assert.equal(entry.provider_name, 'COUNTIF');
    assert.equal(entry.provider_error_type, 4);
    assert.equal(entry.provider_error_text, '计算错误');
    assert.equal(entry.field_type, 'TEXT');
    assert.equal(entry.field_id, 'f_name');
    return true;
  });

  for (const definition of [coalesce, percent, textCountif]) {
    assert.equal(validateFormulaDefinition(definition, fields).status, 'invalid');
  }

  // 直接创建/更新写入路径使用同一个提交前守卫，错误信息必须说明未提交写入。
  for (const [definition, errorType] of [[coalesce, 8], [percent, 8], [textCountif, 4]]) {
    assert.throws(() => assertProviderFormulaSupport(definition.expression, fields, 'write'), error => {
      assert.equal(error.code, 'UNSUPPORTED_FORMULA');
      assert.ok(error.message.includes('未提交写入'));
      assert.equal(error.details.unsupported[0].provider_error_type, errorType);
      return true;
    });
  }
});

test('数值字段的 COUNTIF 保持可用', () => {
  const numericCountif = { expression: { kind: 'call', name: 'count_equals', args: [
    { kind: 'field', field_id: 'f_count' }, { kind: 'constant', value: 0 }] }, result_type: 'number' };
  const validation = validateFormulaDefinition(numericCountif, fields);
  assert.equal(validation.status, 'valid');
  assert.deepEqual(validation.dependencies, ['f_count']);
  assert.doesNotThrow(() => assertFormulaDefinition(numericCountif, fields));
  assert.deepEqual(encodeProviderFormula(numericCountif.expression, fields), [
    { '1': 1, '2': 'COUNTIF(' }, { '1': 2, '3': 'f_count' }, { '1': 1, '2': ',0)' },
  ]);
});
