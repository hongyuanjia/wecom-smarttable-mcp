import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('真实 stdio MCP 公布三十三个工具，新写入口按能力矩阵拒绝并保持旧契约', async () => {
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
    assert.equal(tools.length, 33);
    for (const name of ['create_table', 'update_records', 'add_records', 'delete_records', 'add_fields', 'delete_fields', 'delete_table',
      'update_member_cells', 'create_view', 'update_view', 'delete_view', 'update_fields', 'create_lookup_field', 'create_relation_field',
      'update_relation_cells', 'create_formula_field', 'update_formula_field', 'create_sheet', 'rename_sheet', 'delete_sheet', 'upload_asset']) {
      assert.equal(tools.find(t => t.name === `wecom_${name}`).annotations.readOnlyHint, false, name);
    }
    for (const name of ['capabilities', 'search_members', 'validate_members', 'read_view', 'read_view_records', 'plan_changes', 'verify_changes', 'list_executions']) {
      assert.equal(tools.find(t => t.name === `wecom_${name}`).annotations.readOnlyHint, true, name);
    }
    const query = tools.find(t => t.name === 'wecom_query_records');
    assert.equal(query.annotations.readOnlyHint, true);
    assert.equal(query.inputSchema.additionalProperties, false);
    const executions = tools.find(t => t.name === 'wecom_list_executions');
    assert.equal('plan_id' in executions.inputSchema.properties, true);
    for (const name of ['create_view', 'update_view', 'create_formula_field', 'update_formula_field', 'add_records']) {
      const tool = tools.find(t => t.name === `wecom_${name}`);
      assert.equal('plan_id' in tool.inputSchema.properties, true, name);
      assert.equal(tool.inputSchema.additionalProperties, false, name);
    }
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

    const capabilities = await client.callTool({ name: 'wecom_capabilities', arguments: {} });
    assert.equal(capabilities.structuredContent.authentication.login_state, 'not_probed_this_call');
    assert.ok(capabilities.structuredContent.capabilities.some(item => item.id === 'member.cell.write' && item.status === 'verified'));
    assert.ok(capabilities.structuredContent.capabilities.some(item => item.id === 'member.directory.search' && item.status === 'verified'));
    assert.ok(capabilities.structuredContent.field_types.some(item => item.type === 'USER' && item.write_cell === 'verified'));

    const search = await client.callTool({ name: 'wecom_search_members', arguments: { url, query: 'value_example_name' } });
    assert.equal(search.structuredContent.error.code, 'LOGIN_REQUIRED');

    const validated = await client.callTool({ name: 'wecom_validate_members', arguments: { members: [
      { namespace: 'corp_example', id: 'user_example_1', name: 'value_example_name' },
      { namespace: 'corp_example', id: 'user_example_1' },
    ] } });
    assert.equal(validated.structuredContent.counts.valid, 1);
    assert.equal(validated.structuredContent.counts.duplicate, 1);

    const memberWrite = await client.callTool({ name: 'wecom_update_member_cells', arguments: { url, sheet_id: 'id_example_sheet',
      expected_revision: 1, notify_members: false, updates: [{ record_id: 'id_example_record', field_id: 'id_example_field',
        mode: 'replace', members: [{ namespace: 'corp_example', id: 'user_example_1' }] }] } });
    assert.equal(memberWrite.structuredContent.error.code, 'LOGIN_REQUIRED');

    const notified = await client.callTool({ name: 'wecom_update_member_cells', arguments: { url, sheet_id: 'id_example_sheet',
      expected_revision: 1, notify_members: true, updates: [{ record_id: 'id_example_record', field_id: 'id_example_field',
        mode: 'replace', members: [{ namespace: 'corp_example', id: 'user_example_1' }] }] } });
    assert.equal(notified.structuredContent.error.code, 'NOTIFICATION_CONTROL_UNAVAILABLE');

    const viewWrite = await client.callTool({ name: 'wecom_create_view', arguments: { url, sheet_id: 'id_example_sheet',
      expected_revision: 1, view: { name: 'value_example_view', type: 'grid' } } });
    assert.equal(viewWrite.structuredContent.error.code, 'LOGIN_REQUIRED');

    const dynamic = await client.callTool({ name: 'wecom_create_view', arguments: { url, sheet_id: 'id_example_sheet',
      expected_revision: 1, view: { name: 'value_example_view', type: 'grid', filter: { conjunction: 'and', conditions: [
        { field_id: 'id_example_field', operator: 'contains', value_kind: 'current_viewer' }] } } } });
    assert.equal(dynamic.structuredContent.error.code, 'LOGIN_REQUIRED');

    const readView = await client.callTool({ name: 'wecom_read_view', arguments: { url, sheet_id: 'id_example_sheet', view_id: 'id_example_view' } });
    assert.equal(readView.structuredContent.error.code, 'LOGIN_REQUIRED');
    const plan = await client.callTool({ name: 'wecom_plan_changes', arguments: { url, changes: [{ kind: 'view', action: 'create',
      sheet_id: 'id_example_sheet', patch: { name: 'value_example_view', type: 'grid' } }] } });
    assert.equal(plan.structuredContent.error.code, 'LOGIN_REQUIRED');
    assert.equal(stderr, '');
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
