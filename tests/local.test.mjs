import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('默认资料目录在仓库外，显式配置仍然生效', async t => {
  const env = { ...process.env };
  delete env.WECOM_MCP_DATA_DIR;
  const code = `import {dataDir} from './dist/local.js';import {homedir} from 'node:os';import {join} from 'node:path';console.log(JSON.stringify({matchesDefault:dataDir===join(homedir(),'.local','share','wecom-smarttable-mcp'),insideRepo:dataDir.startsWith(process.cwd()+'/')}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }));
  assert.deepEqual(result, { matchesDefault: true, insideRepo: false });
  const dir = await mkdtemp(join(tmpdir(), 'wecom-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configured = execFileSync(process.execPath, ['--input-type=module', '-e', `import {dataDir} from './dist/local.js';console.log(dataDir===process.env.WECOM_MCP_DATA_DIR);`],
    { env: { ...env, WECOM_MCP_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(configured.trim(), 'true');
});

test('执行日志按文档过滤，保存操作 ID、版本与状态且权限为 600', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const code = `import {saveExecution,listExecutions,executionsPath} from './dist/local.js';import {stat} from 'node:fs/promises';
    const a=await saveExecution({status:'verified',document_id:'id_doc_a',sheet_id:'id_sheet',operation:'update_view',revision:3});
    const b=await saveExecution({status:'not_verified',document_id:'id_doc_b',sheet_id:'id_sheet',operation:'upload_asset',committed_revision:4});
    const list=await listExecutions('id_doc_a');
    const info=await stat(executionsPath);
    console.log(JSON.stringify({count:list.length,id:list[0].execution_id,status:list[0].status,revision:list[0].revision,mode:(info.mode&0o777).toString(8),all: (await listExecutions()).length}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, WECOM_MCP_DATA_DIR: dir }, encoding: 'utf8' }));
  assert.equal(result.count, 1);
  assert.match(result.id, /^e/);
  assert.equal(result.status, 'verified');
  assert.equal(result.revision, 3);
  assert.equal(result.mode, '700');
  assert.equal(result.all, 2);
});
