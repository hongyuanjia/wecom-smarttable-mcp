import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dataDir } from '../dist/local.js';

// 私有目标文件：url、sheet_id、text_field_id、select_field_id、keyword。
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-query.mjs <private-target.json>');
const target = JSON.parse(await readFile(process.argv[2], 'utf8'));
const client = new Client({ name: 'wecom-query-verifier', version: '0.4.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')],
  env: { WECOM_MCP_DATA_DIR: dataDir }, stderr: 'pipe' });
let stderr = '';
transport.stderr.on('data', data => { stderr += data; });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`Query verification failed: ${result.structuredContent?.error?.code || 'UNKNOWN'}`);
  return result.structuredContent;
}
try {
  await client.connect(transport);
  const common = { url: target.url, sheet_id: target.sheet_id };
  const all = []; let cursor;
  do {
    const page = await call('wecom_read_records', { ...common, page_size: 200, ...(cursor ? { cursor } : {}) });
    all.push(...page.records); cursor = page.next_cursor;
  } while (cursor);
  const text = { field_id: target.text_field_id, operator: 'contains', value: target.keyword };
  const sample = all.find(r => r.fields[text.field_id]?.text.includes(text.value)
    && r.fields[target.select_field_id]?.value?.length);
  assert.ok(sample, '目标表需要一条同时具有关键词和单选值的真实记录');
  const select = { field_id: target.select_field_id, operator: 'eq', value: sample.fields[target.select_field_id].value[0] };
  const singleLine = all.find(r => r.fields[text.field_id]?.text && !/[\r\n]/.test(r.fields[text.field_id].text));
  assert.ok(singleLine, '目标表需要一条单行文本记录');
  const equal = { ...text, operator: 'eq', value: singleLine.fields[text.field_id].text };
  const absent = { ...equal, value: `value_example_absent_${crypto.randomUUID()}` };
  const cases = [ ['contains', 'and', [text]], ['select_eq', 'and', [select]], ['text_eq', 'and', [equal]],
    ['and', 'and', [text, select]], ['or', 'or', [text, select]], ['empty', 'and', [absent]] ];
  for (const [name, conjunction, conditions] of cases) {
    const filter = { conjunction, conditions };
    const matches = (row, condition) => condition.field_id === text.field_id
      ? condition.operator === 'contains' ? row.fields[text.field_id].text.includes(condition.value) : row.fields[text.field_id].text === condition.value
      : (row.fields[select.field_id].value || []).includes(condition.value);
    const expected = all.filter(row => conjunction === 'and' ? conditions.every(c => matches(row, c)) : conditions.some(c => matches(row, c)))
      .map(row => row.id).sort();
    const actual = []; let pages = 0; let cursor;
    do {
      const page = await call('wecom_query_records', { ...common, filter, page_size: 7, ...(cursor ? { cursor } : {}) });
      assert.equal(page.filter_execution, 'server');
      assert.equal(page.total_matching_records, expected.length);
      assert.equal(page.view_filter_applied, false);
      for (const row of page.records) for (const cell of Object.values(row.fields)) {
        for (const asset of cell.assets || []) assert.equal('locator' in asset, false);
      }
      actual.push(...page.records.map(row => row.id)); pages++;
      assert.ok(pages <= all.length + 1, '分页必须终止');
      cursor = page.next_cursor;
      assert.equal(page.has_more, Boolean(cursor));
    } while (cursor);
    assert.deepEqual(actual.sort(), expected);
    assert.equal(new Set(actual).size, actual.length);
    console.log(JSON.stringify({ case: name, matched: actual.length, pages, verified: true }));
  }
  const filter = { conjunction: 'and', conditions: [text] };
  const first = await call('wecom_query_records', { ...common, filter, page_size: 1 });
  assert.ok(first.next_cursor);
  for (const [changedFilter, cursor, code] of [
    [{ conjunction: 'and', conditions: [select] }, first.next_cursor, 'INVALID_CURSOR'],
    [filter, (() => { const p = JSON.parse(Buffer.from(first.next_cursor, 'base64url')); p.revision--;
      return Buffer.from(JSON.stringify(p)).toString('base64url'); })(), 'STALE_CURSOR'],
  ]) {
    const result = await client.callTool({ name: 'wecom_query_records', arguments: { ...common, filter: changedFilter, cursor } });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, code);
  }
  assert.equal(stderr, '');
  console.log(JSON.stringify({ query_verified: true, baseline_records: all.length, cursor_checks: 2 }));
} finally { await client.close(); }
