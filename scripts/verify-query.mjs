import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dataDir } from '../dist/local.js';
import { createHash } from 'node:crypto';

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
  const structure = await call('wecom_table_structure', common);
  assert.equal(structure.structure_scope, 'single_sheet');
  assert.deepEqual(structure.sheets.map(sheet => sheet.id), [target.sheet_id]);
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
  const downloadSamples = new Map();
  for (const [name, conjunction, conditions] of cases) {
    const filter = { conjunction, conditions };
    const matches = (row, condition) => condition.field_id === text.field_id
      ? condition.operator === 'contains' ? row.fields[text.field_id].text.includes(condition.value) : row.fields[text.field_id].text === condition.value
      : (row.fields[select.field_id].value || []).includes(condition.value);
    const expected = all.filter(row => conjunction === 'and' ? conditions.every(c => matches(row, c)) : conditions.some(c => matches(row, c)))
      .map(row => row.id).sort();
    const actual = []; let pages = 0; let cursor;
    do {
      const page = await call('wecom_query_records', { ...common, filter, page_size: 31, ...(cursor ? { cursor } : {}) });
      assert.equal(page.filter_execution, 'server');
      assert.equal(page.total_matching_records, expected.length);
      assert.equal(page.view_filter_applied, false);
      for (const row of page.records) for (const [fieldId, cell] of Object.entries(row.fields)) {
        for (const asset of cell.assets || []) {
          assert.deepEqual(asset.locator, { document_id: page.document_id, sheet_id: page.sheet_id,
            record_id: row.id, field_id: fieldId, asset_id: asset.id, source: 'record_query' });
          if ((asset.kind === 'image' || asset.source === 'SS_File') && !downloadSamples.has(asset.kind)) {
            downloadSamples.set(asset.kind, asset);
          }
        }
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
  const projected = await call('wecom_query_records', { ...common, filter, fields: [target.text_field_id], page_size: 1 });
  const next = await call('wecom_query_records', { ...common, filter, cursor: projected.next_cursor, page_size: 1 });
  assert.deepEqual(next.columns.map(column => column.id), [target.text_field_id]);
  assert.notEqual(next.records[0].id, projected.records[0].id);
  for (const [name, extra] of [['wecom_read_records', {}], ['wecom_query_records', { filter }]]) {
    const args = { ...common, ...extra, fields: [target.text_field_id, target.select_field_id], page_size: 31 };
    const full = await call(name, { ...args, include_text_fragments: true });
    const brief = await call(name, args);
    const expected = structuredClone(full.records);
    for (const row of expected) for (const cell of Object.values(row.fields)) delete cell.fragments;
    assert.deepEqual(brief.records, expected);
    assert.equal(brief.text_fragments_included, false);
    const continued = await call(name, { ...common, ...extra, cursor: brief.next_cursor, page_size: 1 });
    assert.equal(continued.text_fragments_included, false);
    assert.deepEqual(continued.columns, brief.columns);
    assert.equal('fragments' in continued.records[0].fields[target.text_field_id], false);
    const restored = await call(name, { ...common, ...extra, cursor: brief.next_cursor, page_size: 1, include_text_fragments: true });
    assert.equal('fragments' in restored.records[0].fields[target.text_field_id], true);
    const bytes = value => Buffer.byteLength(JSON.stringify(value));
    console.log(JSON.stringify({ tool: name, text_projection_verified: true, full_bytes: bytes(full), brief_bytes: bytes(brief) }));
  }
  for (const [changedFilter, cursor, code] of [
    [{ conjunction: 'and', conditions: [select] }, first.next_cursor, 'INVALID_CURSOR'],
    [filter, 'invalid', 'INVALID_CURSOR'],
    [filter, (() => { const p = JSON.parse(Buffer.from(first.next_cursor, 'base64url')); p.revision--;
      return Buffer.from(JSON.stringify(p)).toString('base64url'); })(), 'STALE_CURSOR'],
  ]) {
    const result = await client.callTool({ name: 'wecom_query_records', arguments: { ...common, filter: changedFilter, cursor } });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, code);
  }
  const changedFields = await client.callTool({ name: 'wecom_query_records', arguments: {
    ...common, filter, cursor: projected.next_cursor, fields: [target.select_field_id],
  } });
  assert.equal(changedFields.structuredContent.error.code, 'INVALID_CURSOR');
  const invalidRead = await client.callTool({ name: 'wecom_read_records', arguments: { ...common, cursor: 'invalid' } });
  assert.equal(invalidRead.structuredContent.error.code, 'INVALID_CURSOR');
  for (const asset of downloadSamples.values()) {
    const downloaded = await call('wecom_download_asset', { url: target.url, locator: asset.locator });
    const bytes = await readFile(downloaded.local_path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), downloaded.sha256);
    assert.equal(bytes.length, downloaded.size_bytes);
    const oldLocator = all.find(row => row.id === asset.locator.record_id)
      .fields[asset.locator.field_id].assets.find(original => original.id === asset.id).locator;
    const original = await call('wecom_download_asset', { url: target.url, locator: oldLocator });
    assert.equal(downloaded.sha256, original.sha256);
    for (const [locator, code] of [
      [{ ...asset.locator, record_id: 'rXXXXX' }, 'STALE_ASSET_LOCATOR'],
      [{ ...asset.locator, asset_id: 'id_example_missing_asset' }, 'ASSET_NOT_FOUND'],
    ]) {
      const result = await client.callTool({ name: 'wecom_download_asset', arguments: { url: target.url, locator } });
      assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, code);
    }
    console.log(JSON.stringify({ query_asset_verified: true, kind: asset.kind, same_as_chunk_download: true, size_bytes: bytes.length }));
  }
  assert.equal(stderr, '');
  console.log(JSON.stringify({ query_verified: true, baseline_records: all.length, cursor_checks: 4, fields_inherited: true }));
} finally { await client.close(); }
