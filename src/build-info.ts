// 运行期构建标识：读取构建脚本写入的 dist/build-info.json，并核对当前进程入口文件哈希。
// 只暴露提交、版本与文件哈希，不读取环境中的凭据、链接或业务数据。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BUILD_MODULES, DERIVED_PARSER_VERSION, OUTPUT_SCHEMA_VERSION,
  type BuildModuleName } from './contract-versions.js';

export type { BuildModuleName } from './contract-versions.js';

export interface ModuleFingerprint {
  path: string;
  sha256: string;
}

export interface BuildManifest {
  build_commit: string;
  build_id: string;
  built_at: string;
  package_version: string;
  output_schema_version: string;
  derived_parser_version: string;
  modules: Record<BuildModuleName, ModuleFingerprint>;
}

export interface RunningBuild extends BuildManifest {
  running: {
    started_at: string;
    entry_path: string;
    entry_sha256: string | null;
    matches_build: boolean | null;
  };
}

const MODULE_NAMES = Object.keys(BUILD_MODULES) as BuildModuleName[];
const ENTRY_PATH = `dist/${BUILD_MODULES.entry}`;
const STARTED_AT = new Date().toISOString();
const manifestUrl = new URL('./build-info.json', import.meta.url);
const entryUrl = new URL('./server.js', import.meta.url);

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function isManifest(value: unknown): value is BuildManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!['build_commit', 'build_id', 'built_at', 'package_version', 'output_schema_version', 'derived_parser_version']
    .every(key => isText(candidate[key]))) return false;
  const modules = candidate.modules as Record<string, unknown> | undefined;
  if (!modules || typeof modules !== 'object') return false;
  return MODULE_NAMES.every(name => {
    const module = modules[name] as Record<string, unknown> | undefined;
    return Boolean(module && typeof module === 'object' && isText(module.path) && isHash(module.sha256));
  });
}

function readManifest(): BuildManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function runningEntryHash(): string | null {
  try {
    return sha256(readFileSync(entryUrl));
  } catch {
    return null;
  }
}

// 未经过 npm run build 时保留契约形状，明确标记 unbuilt，不伪造哈希。
function unbuilt(): RunningBuild {
  const modules = Object.fromEntries(MODULE_NAMES.map(name =>
    [name, { path: `dist/${BUILD_MODULES[name]}`, sha256: '' }])) as Record<BuildModuleName, ModuleFingerprint>;
  return {
    build_commit: 'unknown',
    build_id: 'unbuilt',
    built_at: '',
    package_version: 'unknown',
    output_schema_version: OUTPUT_SCHEMA_VERSION,
    derived_parser_version: DERIVED_PARSER_VERSION,
    modules,
    running: { started_at: STARTED_AT, entry_path: ENTRY_PATH, entry_sha256: null, matches_build: null },
  };
}

let cached: RunningBuild | null = null;

export function runningBuild(): RunningBuild {
  if (cached) return cached;
  const manifest = readManifest();
  if (!manifest) return unbuilt();
  const entrySha256 = runningEntryHash();
  cached = { ...manifest, running: {
    started_at: STARTED_AT,
    entry_path: ENTRY_PATH,
    entry_sha256: entrySha256,
    matches_build: entrySha256 === null ? null : entrySha256 === manifest.modules.entry.sha256,
  } };
  return cached;
}
