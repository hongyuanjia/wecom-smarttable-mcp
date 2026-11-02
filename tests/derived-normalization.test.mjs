import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDerivedResult, presentRecord } from '../dist/protocol.js';
import { parseQueryResult } from '../dist/query.js';

const percentPayload = {
  sourceType: 19,
  data: [{ text: '25%', number: 0.25, formatterType: 28, decimalPlaces: 2 }],
};

const derivedCell = (payload, type = 19) => ({ k30: type, k36: { k1: JSON.stringify(payload), k2: true } });
const legacyCell = (payload, type = 19) => ({ k30: type, k3601: payload });
const row = cells => ({ id: 'r1', raw: { k1: cells } });
const schema = fields => ({ fields: fields.map(field => ({ type: 'FORMULA', is_primary: false, ...field })), views: [], raw: {} });

test('k36.k1 字符串与 k3601 对象进入同一标准化入口并输出相同结构', () => {
  const fromStandard = parseDerivedResult(derivedCell(percentPayload));
  const fromLegacy = parseDerivedResult(legacyCell(percentPayload));
  assert.deepEqual(fromLegacy, fromStandard);
  assert.deepEqual(fromStandard, {
    status: 'present',
    value: 0.25,
    result_type: 'PERCENT',
    display_text: '25%',
    items: [
      { text: '25%', formatter_type: 28, result_type: 'PERCENT', number: 0.25, decimal_places: 2 },
    ],
    computed_result: {
      source_type: 19,
      formatter_type: 28,
      result_type: 'PERCENT',
      data: [
        { text: '25%', formatter_type: 28, result_type: 'PERCENT', number: 0.25, decimal_places: 2 },
      ],
    },
  });
  assert.equal(fromStandard.value, 0.25, '百分数保留数值语义，不重复乘以 100');
  assert.equal(fromStandard.display_text, '25%', '显示文本与数值分开保留');
  assert.equal(fromStandard.computed_result.data[0].number, 0.25);
});

const formulaSchema = schema([
  { id: 'f_derived', name: '派生', type_code: 19 },
]);

test('0/false/空字符串/空数组/null 保留，未返回/待计算/解析失败/计算错误分别表示', () => {
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [{ text: '0', number: 0, formatterType: 2 }] })).value, 0);
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [{ text: '否', checked: false, formatterType: 3 }] })).value, false);
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [{ text: '', formatterType: 1 }] })).value, '');
  assert.deepEqual(parseDerivedResult(derivedCell({ sourceType: 19, data: [] })).value, []);
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [] })).status, 'empty');
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [{ text: null, formatterType: 2 }] })).value, null);
  assert.equal(parseDerivedResult(derivedCell({ sourceType: 19, data: [{ text: null, formatterType: 2 }] })).status, 'present');

  const missing = presentRecord({ sheetId: 's1', raw: {} }, formulaSchema, row({}), 'doc', ['f_derived']).fields.f_derived;
  assert.deepEqual(missing, { status: 'not_returned', value: null, result_type: null, computed_result: null });
  assert.equal(parseDerivedResult({ k30: 19, k36: { k2: false } }).status, 'pending');

  const invalid = parseDerivedResult({ k30: 19, k36: { k1: '{', k2: true } });
  assert.equal(invalid.status, 'parse_error');
  assert.equal(invalid.parse_error, 'invalid_json');
  assert.equal(invalid.value, null);
  const missingData = parseDerivedResult({ k30: 19, k36: { k1: '{"sourceType":19}', k2: true } });
  assert.equal(missingData.status, 'parse_error');
  assert.equal(missingData.parse_error, 'missing_data');

  const calculationError = parseDerivedResult(derivedCell({ sourceType: 19,
    data: [{ text: '计算错误', isError: true, errorType: 4, errorMessage: '除数为 0' }] }));
  assert.equal(calculationError.status, 'error');
  assert.deepEqual(calculationError.errors, [{ type: 4, message: '除数为 0', args: null }]);
});

test('LOOKUP 多值、人员、选项、日期、货币与错误一致映射', () => {
  const multiNumbers = parseDerivedResult(derivedCell({ sourceType: 20,
    data: [{ text: '4', number: 4, formatterType: 2 }, { text: '0', number: 0, formatterType: 2 }] }, 20));
  assert.equal(multiNumbers.result_type, 'NUMBER');
  assert.deepEqual(multiNumbers.value, [4, 0]);
  assert.deepEqual(multiNumbers.display_texts, ['4', '0']);

  const users = parseDerivedResult(derivedCell({ sourceType: 20, data: [
    { text: '张三', id: 'uid_1', name: '张三', avatarUrl: 'https://example.invalid/a.png', formatterType: 7 },
    { text: '李四', id: 'uid_2', name: '李四', formatterType: 7 },
  ] }, 20));
  assert.equal(users.result_type, 'USER');
  assert.deepEqual(users.members, [
    { id: 'uid_1', name: '张三', avatar_url: 'https://example.invalid/a.png', namespace: 'wecom_uid' },
    { id: 'uid_2', name: '李四', avatar_url: null, namespace: 'wecom_uid' },
  ]);

  const options = parseDerivedResult(derivedCell({ sourceType: 20, data: [
    { text: '高', id: 'opt_high', formatterType: 17 }, { text: '低', id: 'opt_low', formatterType: 17 },
  ] }, 20));
  assert.deepEqual(options.options, [{ id: 'opt_high', text: '高' }, { id: 'opt_low', text: '低' }]);
  assert.deepEqual(options.value, ['高', '低']);

  const date = parseDerivedResult(derivedCell({ sourceType: 19,
    data: [{ text: '2026年11月2日', timestamp: 1793548800000, formatterType: 4 }] }));
  assert.equal(date.result_type, 'DATE_TIME');
  assert.equal(date.value, 1793548800000);

  const currency = parseDerivedResult(derivedCell({ sourceType: 19,
    data: [{ text: '¥1,234.00', number: 1234, formatterType: 26, decimalPlaces: 2 }] }));
  assert.equal(currency.result_type, 'CURRENCY');
  assert.equal(currency.value, 1234);
  assert.equal(currency.computed_result.data[0].formatter_type, 26);
});

test('未知 formatter 保留原始格式码并标记 UNKNOWN_<code>', () => {
  const unknown = parseDerivedResult(derivedCell({ sourceType: 19,
    data: [{ text: '自定义显示', number: 7, formatterType: 999 }] }));
  assert.equal(unknown.result_type, 'UNKNOWN_999');
  assert.equal(unknown.computed_result.data[0].formatter_type, 999);
  assert.equal(unknown.value, 7);
  const unknownString = parseDerivedResult(derivedCell({ sourceType: 19,
    data: [{ text: '自定义显示', formatterType: '88' }] }));
  assert.equal(unknownString.result_type, 'UNKNOWN_88');
  assert.equal(unknownString.computed_result.data[0].formatter_type, '88');
});

test('双源同时存在时优先 k36.k1 并报告冲突，解析失败不被另一源静默掩盖', () => {
  const conflict = parseDerivedResult({
    k30: 19,
    k36: { k1: JSON.stringify({ sourceType: 19, data: [{ text: '1', number: 1, formatterType: 2 }] }), k2: true },
    k3601: { sourceType: 19, data: [{ text: '2', number: 2, formatterType: 2 }] },
  });
  assert.equal(conflict.status, 'present');
  assert.equal(conflict.value, 1);
  assert.deepEqual(conflict.source_conflict, { preferred: 'k36.k1', alternate: 'k3601' });

  const invalidStandard = parseDerivedResult({
    k30: 19, k36: { k1: '{', k2: true },
    k3601: { sourceType: 19, data: [{ text: '2', number: 2, formatterType: 2 }] },
  });
  assert.equal(invalidStandard.status, 'parse_error');
  assert.equal(invalidStandard.parse_error, 'invalid_json');
  assert.equal(invalidStandard.value, null);
  assert.equal(invalidStandard.alternate_valid, true);

  const invalidLegacy = parseDerivedResult({
    k30: 19,
    k36: { k1: JSON.stringify({ sourceType: 19, data: [{ text: '1', number: 1, formatterType: 2 }] }), k2: true },
    k3601: '{',
  });
  assert.equal(invalidLegacy.status, 'present');
  assert.equal(invalidLegacy.value, 1);
  assert.deepEqual(invalidLegacy.alternate_parse_error, { source: 'k3601', parse_error: 'invalid_json' });

  const legacyString = parseDerivedResult({ k30: 19, k3601: JSON.stringify(percentPayload) });
  const legacyObject = parseDerivedResult(legacyCell(percentPayload));
  assert.deepEqual(legacyString, legacyObject);

  const sameBoth = parseDerivedResult({
    k30: 19,
    k36: { k1: JSON.stringify(percentPayload), k2: true },
    k3601: { data: percentPayload.data, sourceType: percentPayload.sourceType },
  });
  assert.equal('source_conflict' in sameBoth, false, '键顺序或来源表示不同但标准化结果一致时不误报冲突');
});

test('双形态夹具逐字段一致', () => {
  const fixtures = [
    { sourceType: 19, data: [{ text: '0', number: 0, formatterType: 2 }] },
    { sourceType: 19, data: [{ text: '25%', number: 0.25, formatterType: 28 }] },
    { sourceType: 19, data: [{ text: '100%', number: 1, formatterType: 28 }] },
    { sourceType: 19, data: [{ text: '否', checked: false, formatterType: 3 }] },
    { sourceType: 19, data: [{ text: '', formatterType: 1 }] },
    { sourceType: 19, data: [] },
    { sourceType: 20, data: [{ text: '4', number: 4, formatterType: 2 }, { text: '0', number: 0, formatterType: 2 }] },
    { sourceType: 19, data: [{ text: '2026年11月2日', timestamp: 1793548800000, formatterType: 4 }] },
    { sourceType: 19, data: [{ text: '计算错误', isError: true, errorType: 4 }] },
    { sourceType: 19, data: [{ text: '自定义', formatterType: 999 }] },
  ];
  for (const payload of fixtures) {
    assert.deepEqual(parseDerivedResult(legacyCell(payload)),
      parseDerivedResult(derivedCell(payload)), JSON.stringify(payload));
  }
});

test('同一记录字段经整表读取、条件查询和视图读取得到一致标准结果', () => {
  const sheetId = 's1';
  const payload = { sourceType: 19, data: [{ text: '25%', number: 0.25, formatterType: 28 }] };
  const selected = ['f_derived'];
  const readSource = { sheetId, raw: {}, start: 0, end: 0 };
  const viewSource = { sheetId, raw: {}, start: 0, end: 9 };
  const readRow = row({ f_derived: derivedCell(payload) });
  const queryCell = { k30: 19, k100: 'f_derived', k3601: payload };
  const queryResponse = { retcode: 0, result: { data_initing: false, total: 1, has_more: false,
    next_cursor: '', mutation_json: JSON.stringify([[{ t: 3028, v: 5,
      c: { k1: sheetId, k2: { k1: { r1: { k2: [queryCell] } } } } }]]) } };
  const queryPage = parseQueryResult(queryResponse, sheetId, 10);

  const fromRead = presentRecord(readSource, formulaSchema, readRow, 'doc', selected);
  const fromView = presentRecord(viewSource, formulaSchema, readRow, 'doc', selected);
  const fromQuery = presentRecord({ sheetId, raw: queryPage.raw }, formulaSchema, queryPage.records[0], 'doc', selected);
  assert.deepEqual(fromQuery, fromRead);
  assert.deepEqual(fromView, fromRead);
  assert.equal(fromRead.fields.f_derived.value, 0.25);
  assert.equal(fromRead.fields.f_derived.display_text, '25%');
});

test('条件查询分页与总数不受派生字段标准化影响，单条异常不吞掉其他记录', async () => {
  const fixture = JSON.parse(await readFile(new URL('fixtures/query-records.json', import.meta.url)));
  const response = { retcode: 0, result: fixture.query_result };
  const baseline = parseQueryResult(response, fixture.sheet_id, 3);
  assert.equal(baseline.records.length, 3);
  assert.equal(baseline.total, 7);
  assert.equal(baseline.hasMore, true);
  assert.ok(baseline.nextCursor.length > 0);

  const withDerived = structuredClone(response);
  const commands = JSON.parse(withDerived.result.mutation_json);
  const map = commands[0][0].c.k2.k1;
  const firstId = Object.keys(map)[0];
  map[firstId].k2.push({ k30: 19, k100: 'f_derived', k3601: percentPayload });
  withDerived.result.mutation_json = JSON.stringify(commands);
  const page = parseQueryResult(withDerived, fixture.sheet_id, 3);
  assert.equal(page.total, baseline.total);
  assert.equal(page.hasMore, baseline.hasMore);
  assert.equal(page.nextCursor, baseline.nextCursor);
  assert.equal(page.records.length, 3);
  const schemaWithDerived = { fields: [...fixture.columns,
    { id: 'f_derived', name: '派生', type_code: 19, type: 'FORMULA', is_primary: false }], views: [], raw: {} };
  const fields = schemaWithDerived.fields.map(field => field.id);
  const results = page.records.map(record => presentRecord({ sheetId: fixture.sheet_id, raw: page.raw },
    schemaWithDerived, record, 'id_example_document', fields));
  assert.equal(results.find(record => record.id === firstId).fields.f_derived.value, 0.25);
  for (const record of results.filter(result => result.id !== firstId)) {
    assert.equal(record.fields.f_derived.status, 'not_returned');
  }
  assert.equal(results.length, 3);
});
