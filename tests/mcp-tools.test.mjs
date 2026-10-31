import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('真实 stdio MCP 公布十一个工具，删除入口拒绝标题和永久删除参数', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-tool-contract-'));
  const client = new Client({ name: 'wecom-tool-contract', version: '0.4.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { WECOM_MCP_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  try {
    await client.connect(transport);
    const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
    assert.equal(client.getServerVersion().version, packageInfo.version);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    for (const name of ['create_table', 'update_records', 'add_records', 'delete_records', 'add_fields', 'delete_fields', 'delete_table']) {
      assert.equal(tools.find(t => t.name === `wecom_${name}`).annotations.readOnlyHint, false);
    }
    const query = tools.find(t => t.name === 'wecom_query_records');
    assert.equal(query.annotations.readOnlyHint, true);
    assert.equal(query.inputSchema.additionalProperties, false);
    const identity = { document_id: 'id_example_document', sheet_id: 'id_example_sheet', record_id: 'id_example_record',
      field_id: 'id_example_field', asset_id: 'id_example_asset' };
    const url = 'https://doc.weixin.qq.com/smartsheet/id_example_document';
    for (const locator of [{ ...identity, source: 'record_query' }, { ...identity, chunk_start: 0, chunk_size: 1 }]) {
      const result = await client.callTool({ name: 'wecom_download_asset', arguments: { url, locator } });
      assert.equal(result.structuredContent.error.code, 'LOGIN_REQUIRED', '两种定位器均通过 schema，随后执行真实登录态校验');
    }
    const scoped = await client.callTool({ name: 'wecom_table_structure', arguments: { url, sheet_id: 'id_example_sheet' } });
    assert.equal(scoped.structuredContent.error.code, 'LOGIN_REQUIRED');
    const removal = tools.find(t => t.name === 'wecom_delete_table');
    assert.equal(removal.annotations.destructiveHint, true);
    assert.equal(removal.inputSchema.additionalProperties, false);
    assert.equal('title' in removal.inputSchema.properties, false);
    assert.equal('permanent' in removal.inputSchema.properties, false);
    for (const args of [{ title: 'value_example_title' }, { document_id: 'id_example_document', permanent: true }]) {
      try {
        const result = await client.callTool({ name: 'wecom_delete_table', arguments: args });
        assert.equal(result.isError, true);
        assert.notEqual(result.structuredContent?.error?.code, 'LOGIN_REQUIRED');
      } catch (error) { assert.equal(error.code, -32602); }
    }
    for (const locator of [
      { ...identity, source: 'record_query', chunk_start: 0, chunk_size: 1 },
      { ...identity, source: 'value_example_unknown_source' }, { ...identity, chunk_start: 0 },
    ]) {
      try {
        const result = await client.callTool({ name: 'wecom_download_asset', arguments: { url, locator } });
        assert.equal(result.isError, true);
        assert.notEqual(result.structuredContent?.error?.code, 'LOGIN_REQUIRED');
      } catch (error) { assert.equal(error.code, -32602); }
    }
    assert.equal(stderr, '');
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
