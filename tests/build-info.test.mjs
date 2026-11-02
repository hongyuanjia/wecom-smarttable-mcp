import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildInfo, writeBuildInfo } from '../scripts/generate-build-info.mjs';
import { BUILD_MODULES, DERIVED_PARSER_VERSION, OUTPUT_SCHEMA_VERSION } from '../dist/contract-versions.js';

const hash = data => createHash('sha256').update(data).digest('hex');

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-build-info-'));
  const distDir = join(dir, 'dist');
  await mkdir(distDir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'wecom-smarttable-mcp', version: '1.2.3', type: 'module' }));
  await writeFile(join(distDir, 'contract-versions.js'),
    `export const OUTPUT_SCHEMA_VERSION = '7';
export const DERIVED_PARSER_VERSION = '9';
export const BUILD_MODULES = ${JSON.stringify(BUILD_MODULES)};
`);
  for (const file of Object.values(BUILD_MODULES)) await writeFile(join(distDir, file), `// ${file} module\n`);
  return { dir, distDir };
}

test('构建指纹覆盖入口、协议、视图语义、视图、写入与计划模块，并记录输出契约版本', async t => {
  const { dir, distDir } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const info = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  assert.equal(info.build_commit, 'abc123');
  assert.equal(info.package_version, '1.2.3');
  assert.equal(info.output_schema_version, '7');
  assert.equal(info.derived_parser_version, '9');
  assert.deepEqual(Object.keys(info.modules),
    ['entry', 'protocol', 'views', 'view-semantics', 'writer', 'planner']);
  for (const [name, file] of Object.entries(BUILD_MODULES)) {
    assert.equal(info.modules[name].path, `dist/${file}`);
    assert.equal(info.modules[name].sha256, hash(await readFile(join(distDir, file))), name);
  }
  assert.match(info.build_id, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(info.built_at)));
});

test('相同模块内容的指纹可复现，模块或输出契约变化则 build_id 变化', async t => {
  const { dir, distDir } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  const rebuilt = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  assert.equal(rebuilt.build_id, first.build_id, '同一份源码重建应得到相同 build_id');

  await writeFile(join(distDir, BUILD_MODULES.protocol), '// changed protocol module\n');
  const changed = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  assert.notEqual(changed.build_id, first.build_id);

  await writeFile(join(distDir, BUILD_MODULES['view-semantics']), '// changed view semantics module\n');
  const semanticsChanged = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  assert.notEqual(semanticsChanged.build_id, changed.build_id, '视图语义变化必须改变构建指纹');

  await writeFile(join(distDir, 'contract-versions.js'),
    `export const OUTPUT_SCHEMA_VERSION = '8';
export const DERIVED_PARSER_VERSION = '9';
export const BUILD_MODULES = ${JSON.stringify(BUILD_MODULES)};
`);
  const versioned = await createBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  assert.notEqual(versioned.build_id, changed.build_id, '输出结构版本变化必须改变构建指纹');
});

test('缺少 git 或环境覆盖时 build_commit 分别取 HEAD 与 unknown，并写出 dist/build-info.json', async t => {
  const { dir, distDir } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fromEnv = await createBuildInfo({ distDir, rootDir: dir, env: { WECOM_BUILD_COMMIT: 'env456' }, gitCommit: () => 'head789' });
  assert.equal(fromEnv.build_commit, 'env456');
  const fromGit = await createBuildInfo({ distDir, rootDir: dir, env: {}, gitCommit: () => 'head789' });
  assert.equal(fromGit.build_commit, 'head789');
  const unknown = await createBuildInfo({ distDir, rootDir: dir, env: {}, gitCommit: () => null });
  assert.equal(unknown.build_commit, 'unknown');

  const written = await writeBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  const manifest = JSON.parse(await readFile(join(distDir, 'build-info.json'), 'utf8'));
  assert.deepEqual(manifest, written);
  assert.equal(manifest.build_commit, 'abc123');
});

test('构建元数据不包含本机路径、凭据或业务数据', async t => {
  const { dir, distDir } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeBuildInfo({ distDir, rootDir: dir, commit: 'abc123' });
  const text = JSON.stringify(written);
  assert.equal(text.includes(dir), false);
  assert.equal(/\/Users\/|\/home\/|[A-Za-z]:\\\\Users/.test(text), false);
  assert.equal(/https?:\/\//.test(text), false);
  assert.equal(/scode=|access_token|signature=/i.test(text), false);
});

test('派生字段标准化契约升级同步到构建指纹版本', () => {
  assert.equal(DERIVED_PARSER_VERSION, '3');
  assert.equal(OUTPUT_SCHEMA_VERSION, '4');
});
