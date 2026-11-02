#!/usr/bin/env node
// 构建指纹：只覆盖已编译的关键模块内容与输出契约版本，不写本机路径、凭据或业务数据。
// build_id 由模块哈希与版本号决定，同一份源码重建可复现；build_commit 单独记录源码来源。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUILD_MODULES = Object.freeze({
  entry: 'server.js',
  protocol: 'protocol.js',
  views: 'views.js',
  writer: 'writer.js',
  planner: 'planner.js',
});

export const BUILD_COMMIT_ENV = 'WECOM_BUILD_COMMIT';
const MANIFEST_FILE = 'build-info.json';

const sha256 = data => createHash('sha256').update(data).digest('hex');

export function detectGitCommit({ cwd = process.cwd() } = {}) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return head || null;
  } catch {
    return null;
  }
}

function resolveCommit({ env, commit, gitCommit, rootDir }) {
  if (typeof commit === 'string' && commit.trim()) return commit.trim();
  const fromEnv = typeof env?.[BUILD_COMMIT_ENV] === 'string' ? env[BUILD_COMMIT_ENV].trim() : '';
  if (fromEnv) return fromEnv;
  return gitCommit({ cwd: rootDir }) || 'unknown';
}

export async function createBuildInfo({ distDir = resolve('dist'), rootDir = resolve('.'), env = process.env,
  commit, gitCommit = detectGitCommit } = {}) {
  const packageInfo = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  // dist/contract-versions.js 是编译产物；加查询参数避免同一进程内重复构建时命中旧模块缓存。
  const versions = await import(`${pathToFileURL(join(distDir, 'contract-versions.js')).href}?v=${Date.now()}`);
  const outputSchemaVersion = String(versions.OUTPUT_SCHEMA_VERSION);
  const derivedParserVersion = String(versions.DERIVED_PARSER_VERSION);

  const modules = {};
  for (const [name, file] of Object.entries(BUILD_MODULES)) {
    modules[name] = { path: `dist/${file}`, sha256: sha256(readFileSync(join(distDir, file))) };
  }

  const buildId = sha256(JSON.stringify({
    output_schema_version: outputSchemaVersion,
    derived_parser_version: derivedParserVersion,
    modules,
  }));

  return {
    build_commit: resolveCommit({ env, commit, gitCommit, rootDir }),
    build_id: `sha256:${buildId}`,
    built_at: new Date().toISOString(),
    package_version: typeof packageInfo.version === 'string' ? packageInfo.version : 'unknown',
    output_schema_version: outputSchemaVersion,
    derived_parser_version: derivedParserVersion,
    modules,
  };
}

export async function writeBuildInfo(options = {}) {
  const distDir = options.distDir || resolve('dist');
  const info = await createBuildInfo({ ...options, distDir });
  writeFileSync(join(distDir, MANIFEST_FILE), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const info = await writeBuildInfo();
    process.stdout.write(`build metadata written: ${info.build_id} (${info.build_commit})\n`);
  } catch (error) {
    process.stderr.write(`build metadata failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
