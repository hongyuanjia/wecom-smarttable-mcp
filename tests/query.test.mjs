import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { querySpec, parseQueryResult, queryFingerprint } from '../dist/query.js';
import { presentRecord } from '../dist/protocol.js';
const fixture = JSON.parse(await readFile(new URL('fixtures/query-records.json', import.meta.url)));
const response = { retcode: 0, result: fixture.query_result };
const schema = { fields: fixture.columns, views: [], raw: {} };
const text = schema.fields.find(f => f.type_code === 1);
const select = schema.fields.find(f => f.id === fixture.filter_field_id);

test('真实查询响应解析单元格列表，保留记录及字段值，不伪造下载 locator', () => {
  const q = parseQueryResult(response, fixture.sheet_id, 3);
  assert.equal(q.records.length, 3);
  assert.equal(q.total, 7);
  assert.equal(q.hasMore, true);
  const chunk = { sheetId: fixture.sheet_id, raw: q.raw };
  for (const row of q.records) {
    const result = presentRecord(chunk, schema, row, 'id_example_document', schema.fields.map(f => f.id), false);
    assert.equal(result.fields[select.id].status, 'present');
    assert.deepEqual(result.fields[select.id].value, [select.options[0].id]);
    assert.ok(result.fields[text.id].text.length > 0);
  }
});

test('字段类型决定真实筛选参数，文本与单选值使用不同协议', () => {
  const filter = { conjunction: 'or', conditions: [
    { field_id: text.id, operator: 'contains', value: 'value_example_text' },
    { field_id: select.id, operator: 'eq', value: select.options[0].id },
  ] };
  assert.deepEqual(querySpec(schema, filter), { conjunction: 2, conditions: [
    { fieldId: text.id, filterKeyType: 1, operator: 3, valueText: 'value_example_text' },
    { fieldId: select.id, filterKeyType: 17, operator: 1, valueSingleSelect: [select.options[0].id] },
  ] });
  assert.notEqual(queryFingerprint(filter, [text.id]), queryFingerprint(filter, [select.id]));
  for (const [condition,code] of [
    [{ field_id: 'id_example_missing', operator: 'eq', value: 'value_example_text' }, 'UNKNOWN_FIELD'],
    [{ field_id: select.id, operator: 'eq', value: 'value_example_unknown' }, 'UNKNOWN_OPTION'],
    [{ field_id: text.id, operator: 'eq', value: 'value_example_line1\nvalue_example_line2' }, 'UNSUPPORTED_FILTER'],
    [{ field_id: select.id, operator: 'contains', value: select.options[0].id }, 'UNSUPPORTED_FILTER'],
  ]) assert.throws(() => querySpec(schema, { conjunction: 'and', conditions: [condition] }), e => e.code === code);
});

test('查询子表、分页和命令不完整时拒绝成功，不把异常当作无匹配', () => {
  assert.throws(() => parseQueryResult(response, 'id_example_other_sheet', 3), e => e.code === 'PARSE_ERROR');
  for (const change of [r => { r.result.next_cursor = ''; }, r => { r.result.total = 1; },
    r => { r.result.mutation_json = 'invalid'; }, r => { r.result.data_initing = true; }]) {
    const r = structuredClone(response); change(r);
    assert.throws(() => parseQueryResult(r, fixture.sheet_id, 3));
  }
});

test('真实无匹配响应没有记录 delta，正确返回零而非解析失败', () => {
  const result = parseQueryResult({ retcode: 0, result: fixture.empty_query_result }, fixture.sheet_id, 3);
  assert.deepEqual(result.records, []);
  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, '');
});
