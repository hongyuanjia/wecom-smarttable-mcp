import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { querySpec, parseQueryResult, queryFingerprint } from '../dist/query.js';
import { parseReadCursor, parseQueryCursor } from '../dist/cursor.js';
import { presentRecord, selectFields } from '../dist/protocol.js';
const fixture = JSON.parse(await readFile(new URL('fixtures/query-records.json', import.meta.url)));
const response = { retcode: 0, result: fixture.query_result };
const schema = { fields: fixture.columns, views: [], raw: {} };
const text = schema.fields.find(f => f.type_code === 1);
const select = schema.fields.find(f => f.id === fixture.filter_field_id);

test('真实查询响应解析单元格列表，保留记录及字段值', () => {
  const q = parseQueryResult(response, fixture.sheet_id, 3);
  assert.equal(q.records.length, 3);
  assert.equal(q.total, 7);
  assert.equal(q.hasMore, true);
  const chunk = { sheetId: fixture.sheet_id, raw: q.raw };
  for (const row of q.records) {
    const result = presentRecord(chunk, schema, row, 'id_example_document', schema.fields.map(f => f.id));
    assert.equal(result.fields[select.id].status, 'present');
    assert.deepEqual(result.fields[select.id].value, [select.options[0].id]);
    assert.ok(result.fields[text.id].text.length > 0);
  }
});

test('省略原始文本片段时，正文、状态、选项及链接保持一致', () => {
  const page = parseQueryResult(response, fixture.sheet_id, 3);
  const source = { sheetId: fixture.sheet_id, raw: page.raw };
  const fields = schema.fields.map(f => f.id);
  for (const row of page.records) {
    const full = presentRecord(source, schema, row, 'id_example_document', fields, true);
    const brief = presentRecord(source, schema, row, 'id_example_document', fields);
    assert.ok('fragments' in full.fields[text.id]);
    assert.equal('fragments' in brief.fields[text.id], false);
    for (const cell of Object.values(full.fields)) delete cell.fragments;
    assert.deepEqual(brief, full);
  }
});

test('服务端字段字典重排不改变请求字段和记录字段的输出顺序', () => {
  const ids = [text.id, select.id];
  const reversed = { ...schema, fields: [...schema.fields].reverse() };
  assert.deepEqual(selectFields(schema, ids), selectFields(reversed, ids));
  assert.deepEqual(selectFields(reversed, ids).map(field => field.id), ids);
  const page = parseQueryResult(response, fixture.sheet_id, 3);
  const source = { sheetId: fixture.sheet_id, raw: page.raw };
  assert.deepEqual(Object.keys(presentRecord(source, reversed, page.records[0], 'id_example_document', ids).fields), ids);
  assert.throws(() => selectFields(schema, ['id_example_unknown']), e => e.code === 'UNKNOWN_FIELD');
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

test('真实按 ID 回读保留附件归属，查询 locator 不依赖整表分页位置', async () => {
  const fixture = JSON.parse(await readFile(new URL('fixtures/record-query.json', import.meta.url)));
  const schema = { fields: fixture.columns, views: [], raw: {} };
  const page = parseQueryResult({ retcode: 0, result: fixture.query_result }, fixture.sheet_id, 1);
  assert.equal(page.records[0].id, fixture.record_id);
  const result = presentRecord({ sheetId: fixture.sheet_id, raw: page.raw }, schema, page.records[0], 'id_example_document', schema.fields.map(f => f.id));
  const assets = Object.entries(result.fields).flatMap(([fieldId, cell]) => cell.assets.map(asset => ({ fieldId, asset })));
  assert.ok(assets.length > 0);
  for (const { fieldId, asset } of assets) {
    assert.deepEqual(asset.locator, { document_id: 'id_example_document', sheet_id: fixture.sheet_id,
      record_id: fixture.record_id, field_id: fieldId, asset_id: asset.id, source: 'record_query' });
    assert.equal('url' in asset, false);
  }
  const absent = parseQueryResult({ retcode: 0, result: fixture.missing_query_result }, fixture.sheet_id, 1);
  assert.equal(absent.total, 1); // 按 ID 查询的 total 是请求数量，不代表记录确实存在。
  assert.deepEqual(absent.records, []);
});

test('查询游标保留字段选择，拒绝损坏数据及不匹配的文档/子表', () => {
  const position = { v: 4, document_id: 'id_example_document', sheet_id: fixture.sheet_id,
    revision: 1, fingerprint: queryFingerprint({}, [text.id]), offset: 1, token: 'value_example_server_cursor', fields: [text.id], include_text_fragments: false };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.deepEqual(parseQueryCursor(encode(position), position.document_id, position.sheet_id), position);
  const brief = { ...position, include_text_fragments: false };
  assert.equal(parseQueryCursor(encode(brief), position.document_id, position.sheet_id).include_text_fragments, false);
  for (const input of ['invalid', encode(null), encode({ ...position, revision: -1 }), encode({ ...position, v: 2 }),
    encode({ ...position, fields: [null] }), encode({ ...position, fingerprint: null }),
    encode({ ...position, document_id: 'id_example_other_document' })]) {
    assert.throws(() => parseQueryCursor(input, position.document_id, position.sheet_id), e => e.code === 'INVALID_CURSOR');
  }
});

test('普通读取游标同样验证字段和输出设置，损坏输入统一为 INVALID_CURSOR', () => {
  const position = { v: 3, document_id: 'id_example_document', sheet_id: fixture.sheet_id,
    revision: 1, offset: 1, fields: [text.id], include_text_fragments: false };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.deepEqual(parseReadCursor(encode(position), position.document_id, position.sheet_id), position);
  for (const value of ['invalid', encode(null), encode({ ...position, fields: [null] }),
    encode({ ...position, fields: undefined }), encode({ ...position, include_text_fragments: 'false' })]) {
    assert.throws(() => parseReadCursor(value, position.document_id, position.sheet_id), e => e.code === 'INVALID_CURSOR');
  }
});

test('损坏的查询 delta/记录映射/单元格结构明确返回 PARSE_ERROR', () => {
  const corrupt = change => {
    const r = structuredClone(response);
    const commands = JSON.parse(r.result.mutation_json);
    change(commands[0][0].c);
    r.result.mutation_json = JSON.stringify(commands);
    return r;
  };
  for (const change of [c => { c.k2 = null; }, c => { c.k2.k1 = false; },
    c => { Object.values(c.k2.k1)[0].k2[0] = null; },
    c => { const cells = Object.values(c.k2.k1)[0].k2; cells.push(cells[0]); }]) {
    assert.throws(() => parseQueryResult(corrupt(change), fixture.sheet_id, 3), e => e.code === 'PARSE_ERROR');
  }
});


test('查询扩展：人员/数字/日期/空值与比较运算符使用真实协议键', () => {
  const extended = { fields: [
    { id: 'f_text', type_code: 1, type: 'TEXT' },
    { id: 'f_user', type_code: 7, type: 'USER' },
    { id: 'f_number', type_code: 2, type: 'NUMBER' },
    { id: 'f_date', type_code: 4, type: 'DATE_TIME' },
    { id: 'f_select', type_code: 17, type: 'SINGLE_SELECT', options: [{ id: 'o_done', name: '完成' }] },
    { id: 'f_url', type_code: 8, type: 'URL' },
    { id: 'f_link', type_code: 18, type: 'LINK_RECORDS' },
  ] };
  const spec = querySpec(extended, { conjunction: 'and', conditions: [
    { field_id: 'f_user', operator: 'eq', value: 'uid_example' },
    { field_id: 'f_number', operator: 'gte', value: 3 },
    { field_id: 'f_date', operator: 'lt', value: 1794000000000 },
    { field_id: 'f_text', operator: 'empty' },
    { field_id: 'f_select', operator: 'ne', value: 'o_done' },
  ] });
  assert.deepEqual(spec.conditions[0], { fieldId: 'f_user', filterKeyType: 7, operator: 1, valueUsers: ['uid_example'] });
  assert.deepEqual(spec.conditions[1], { fieldId: 'f_number', filterKeyType: 2, operator: 6, valueNumber: 3 });
  assert.deepEqual(spec.conditions[2], { fieldId: 'f_date', filterKeyType: 4, operator: 7, valueDateTime: { type: 1, timestamps: [1794000000000] } });
  assert.deepEqual(spec.conditions[3], { fieldId: 'f_text', filterKeyType: 1, operator: 9 });
  assert.deepEqual(spec.conditions[4], { fieldId: 'f_select', filterKeyType: 17, operator: 2, valueSingleSelect: ['o_done'] });
});

test('查询扩展：URL/电话/邮箱/复选框/多选/进度使用已验证的值键与类型', () => {
  const typed = { fields: [
    { id: 'f_url', type_code: 8, type: 'URL' },
    { id: 'f_phone', type_code: 15, type: 'PHONE' },
    { id: 'f_email', type_code: 16, type: 'EMAIL' },
    { id: 'f_check', type_code: 3, type: 'CHECKBOX' },
    { id: 'f_multi', type_code: 9, type: 'MULTIPLE_SELECT',
      options: [{ id: 'o_red', name: '红' }, { id: 'o_blue', name: '蓝' }] },
    { id: 'f_progress', type_code: 14, type: 'PROGRESS' },
  ] };
  const spec = querySpec(typed, { conjunction: 'and', conditions: [
    { field_id: 'f_url', operator: 'eq', value: 'https://example.org/path' },
    { field_id: 'f_phone', operator: 'contains', value: '138000' },
    { field_id: 'f_email', operator: 'ne', value: 'alpha@example.com' },
    { field_id: 'f_check', operator: 'eq', value: true },
    { field_id: 'f_multi', operator: 'contains', value: ['o_red'] },
    { field_id: 'f_progress', operator: 'gte', value: 50 },
  ] });
  assert.deepEqual(spec.conditions, [
    { fieldId: 'f_url', filterKeyType: 8, operator: 1, valueUrl: 'https://example.org/path' },
    { fieldId: 'f_phone', filterKeyType: 15, operator: 3, valuePhoneNumber: '138000' },
    { fieldId: 'f_email', filterKeyType: 16, operator: 2, valueEmail: 'alpha@example.com' },
    { fieldId: 'f_check', filterKeyType: 3, operator: 1, valueCheckbox: true },
    { fieldId: 'f_multi', filterKeyType: 9, operator: 3, valueSelects: ['o_red'] },
    { fieldId: 'f_progress', filterKeyType: 14, operator: 6, valueProgress: 50 },
  ]);
  for (const [condition, code] of [
    [{ field_id: 'f_url', operator: 'eq', value: true }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_url', operator: 'eq', value: ['https://example.org'] }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_phone', operator: 'eq', value: 13800000001 }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_email', operator: 'eq', value: '' }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_check', operator: 'eq', value: 'true' }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_check', operator: 'gt', value: true }, 'UNSUPPORTED_FILTER'],
    [{ field_id: 'f_multi', operator: 'eq', value: 'o_red' }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_multi', operator: 'eq', value: [] }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_multi', operator: 'eq', value: ['o_unknown'] }, 'UNKNOWN_OPTION'],
    [{ field_id: 'f_progress', operator: 'gte', value: { number_value: 50 } }, 'INVALID_ARGUMENT'],
  ]) assert.throws(() => querySpec(typed, { conjunction: 'and', conditions: [condition] }), e => e.code === code);

  assert.deepEqual(querySpec(typed, { conjunction: 'and', conditions: [
    { field_id: 'f_check', operator: 'empty' },
    { field_id: 'f_multi', operator: 'not_empty' },
  ] }).conditions, [
    { fieldId: 'f_check', filterKeyType: 3, operator: 9 },
    { fieldId: 'f_multi', filterKeyType: 9, operator: 10 },
  ]);
  assert.notEqual(queryFingerprint({ conditions: [{ field_id: 'f_url', operator: 'eq', value: 'https://example.org/a' }] }, ['f_url']),
    queryFingerprint({ conditions: [{ field_id: 'f_url', operator: 'eq', value: 'https://example.org/b' }] }, ['f_url']));
});

test('关联与双向关联按关联记录标题文本筛值，空值仍用字段类型码', () => {
  const linked = { fields: [
    { id: 'f_link', type_code: 18, type: 'LINK_RECORDS' },
    { id: 'f_two', type_code: 21, type: 'TWO_WAY_LINK_RECORDS' },
  ] };
  const spec = querySpec(linked, { conjunction: 'or', conditions: [
    { field_id: 'f_link', operator: 'contains', value: '张三' },
    { field_id: 'f_link', operator: 'ne', value: '张三' },
    { field_id: 'f_two', operator: 'eq', value: '张三' },
    { field_id: 'f_two', operator: 'not_contains', value: '李四' },
    { field_id: 'f_link', operator: 'empty' },
    { field_id: 'f_two', operator: 'not_empty' },
  ] });
  assert.deepEqual(spec.conditions, [
    { fieldId: 'f_link', filterKeyType: 1, operator: 3, valueText: '张三' },
    { fieldId: 'f_link', filterKeyType: 1, operator: 2, valueText: '张三' },
    { fieldId: 'f_two', filterKeyType: 1, operator: 1, valueText: '张三' },
    { fieldId: 'f_two', filterKeyType: 1, operator: 4, valueText: '李四' },
    { fieldId: 'f_link', filterKeyType: 18, operator: 9 },
    { fieldId: 'f_two', filterKeyType: 21, operator: 10 },
  ]);
  for (const [condition, code] of [
    [{ field_id: 'f_link', operator: 'gt', value: '张三' }, 'UNSUPPORTED_FILTER'],
    [{ field_id: 'f_link', operator: 'contains', value: ['张三'] }, 'INVALID_ARGUMENT'],
    [{ field_id: 'f_two', operator: 'eq', value: '' }, 'INVALID_ARGUMENT'],
  ]) assert.throws(() => querySpec(linked, { conjunction: 'and', conditions: [condition] }), e => e.code === code);
});
