import test from 'node:test';
import assert from 'node:assert/strict';
import { presentRecord, parseDerivedResult } from '../dist/protocol.js';

const schema = { fields: [
  { id: 'f_lookup_text', name: '文本引用', type_code: 20, type: 'LOOKUP', is_primary: false },
  { id: 'f_lookup_user', name: '人员引用', type_code: 20, type: 'LOOKUP', is_primary: false },
  { id: 'f_lookup_number', name: '数字引用', type_code: 20, type: 'LOOKUP', is_primary: false },
  { id: 'f_formula_text', name: '公式文本', type_code: 19, type: 'FORMULA', is_primary: false },
  { id: 'f_formula_date', name: '公式日期', type_code: 19, type: 'FORMULA', is_primary: false },
  { id: 'f_formula_percent', name: '公式百分比', type_code: 19, type: 'FORMULA', is_primary: false },
  { id: 'f_formula_error', name: '公式错误', type_code: 19, type: 'FORMULA', is_primary: false },
], views: [], raw: {} };

const cell = (value, type = 20) => ({ k30: type, k31: '', k32: '0', k36: { k1: JSON.stringify(value), k2: true } });
const row = cells => ({ id: 'r1', raw: { k1: cells } });

test('LOOKUP 文本/人员/数字保留返回类型和成员引用', () => {
  const record = row({
    f_lookup_text: cell({ sourceType: 20, data: [{ text: '建设任务', type: 'text', link: '', isEnd: true, formatterType: 1 }] }),
    f_lookup_user: cell({ sourceType: 20, data: [{ text: '张三', id: 'uid_example', name: '张三', avatarUrl: '', formatterType: 7 }] }),
    f_lookup_number: cell({ sourceType: 20, data: [{ text: '6', number: 6, formatterType: 2 }] }),
  });
  const values = presentRecord({ sheetId: 's1', raw: {} }, schema, record, 'doc', ['f_lookup_text', 'f_lookup_user', 'f_lookup_number']).fields;
  assert.equal(values.f_lookup_text.status, 'present');
  assert.equal(values.f_lookup_text.value, '建设任务');
  assert.equal(values.f_lookup_text.result_type, 'TEXT');
  assert.equal(values.f_lookup_user.result_type, 'USER');
  assert.deepEqual(values.f_lookup_user.members, [{ id: 'uid_example', name: '张三', avatar_url: '', namespace: 'wecom_uid' }]);
  assert.equal(values.f_lookup_number.value, 6);
  assert.equal(values.f_lookup_number.computed_result.data[0].formatter_type, 2);
});

test('公式日期/百分比/空结果/错误分别报告，不把未返回当成空值', () => {
  const values = presentRecord({ sheetId: 's1', raw: {} }, schema, row({
    f_formula_text: cell({ sourceType: 19, data: [{ text: '待确定日期', type: 'text', isEnd: true, formatterType: 1 }] }, 19),
    f_formula_date: cell({ sourceType: 19, data: [{ timestamp: 1793548800000, text: '2026年11月2日', formatterType: 4 }] }, 19),
    f_formula_percent: cell({ sourceType: 19, data: [{ text: '50%', number: 0.5, formatterType: 28 }] }, 19),
    f_formula_error: cell({ sourceType: 19, data: [{ text: '计算错误', isError: true, errorType: 4 }] }, 19),
  }), 'doc', ['f_formula_text', 'f_formula_date', 'f_formula_percent', 'f_formula_error']).fields;
  assert.equal(values.f_formula_text.value, '待确定日期');
  assert.equal(values.f_formula_text.result_type, 'TEXT');
  assert.equal(values.f_formula_date.result_type, 'DATE_TIME');
  assert.equal(values.f_formula_date.value, 1793548800000);
  assert.equal(values.f_formula_percent.result_type, 'PERCENT');
  assert.equal(values.f_formula_percent.value, 0.5);
  assert.equal(values.f_formula_error.status, 'error');
  assert.equal(values.f_formula_error.errors[0].type, 4);

  const empty = parseDerivedResult(cell({ sourceType: 20, data: [] }));
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.value, []);
  const pending = parseDerivedResult({ k30: 19, k36: { k2: false } });
  assert.equal(pending.status, 'pending');
  assert.equal(parseDerivedResult(undefined), null);
  assert.equal(presentRecord({ sheetId: 's1', raw: {} }, schema, row({}), 'doc', ['f_formula_text']).fields.f_formula_text.status, 'not_returned');
});
