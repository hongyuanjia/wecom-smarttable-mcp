import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WecomError } from './errors.js';

export const dataDir = resolve(process.env.WECOM_MCP_DATA_DIR || join(homedir(), '.local', 'share', 'wecom-smarttable-mcp'));
export const statePath = join(dataDir, 'state.json');
export const profilePath = join(dataDir, 'profile');
export const plansPath = join(dataDir, 'plans');
export const executionsPath = join(dataDir, 'executions');

export async function privateDirectory(path = dataDir) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WecomError('LOCAL_SECURITY_ERROR', '本地数据目录不能是符号链接。');
  await chmod(path, 0o700);
  return path;
}

export async function saveState(value: unknown) {
  await privateDirectory();
  const temp = join(dataDir, `state-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, statePath);
}

export function documentUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new WecomError('INVALID_URL', '需要企业微信智能表格的 HTTPS 链接。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'doc.weixin.qq.com' || url.port || url.username || url.password) {
    throw new WecomError('INVALID_URL', '仅接受 https://doc.weixin.qq.com 上的智能表格链接。');
  }
  const match = /^\/smartsheet\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new WecomError('UNSUPPORTED_TYPE', '第一版只支持企业微信智能表格，不支持普通文档、电子表格或收集表。');
  const canonical = new URL(`/smartsheet/${match[1]}`, url.origin);
  for (const key of ['scode', 'tab', 'viewId']) {
    const value = url.searchParams.get(key);
    if (value) canonical.searchParams.set(key, value);
  }
  return { id: match[1], url: canonical };
}

export function documentReference(input: { url?: string; document_id?: string }) {
  if (!input.url && !input.document_id) throw new WecomError('INVALID_ARGUMENT', '需要 URL 或真实 document_id，不能按标题定位文档。');
  if (input.document_id !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(input.document_id)) throw new WecomError('INVALID_ARGUMENT', 'document_id 格式无效。');
  const doc = documentUrl(input.url || `https://doc.weixin.qq.com/smartsheet/${input.document_id}`);
  if (input.document_id !== undefined && doc.id !== input.document_id) throw new WecomError('DOCUMENT_ID_MISMATCH', 'URL 与 document_id 指向不同文档，尚未操作。');
  return doc;
}

export async function savePlan(planId: string, value: unknown) {
  if (!/^[a-f0-9]{64}$/.test(planId)) throw new WecomError('INVALID_ARGUMENT', '计划 ID 格式无效。');
  await privateDirectory(plansPath);
  const path = join(plansPath, `${planId}.json`);
  const temp = join(plansPath, `plan-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
  return path;
}

export async function loadPlan(planId: string) {
  if (!/^[a-f0-9]{64}$/.test(planId)) throw new WecomError('INVALID_ARGUMENT', '计划 ID 格式无效。');
  try {
    const info = await lstat(join(plansPath, `${planId}.json`));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
    return JSON.parse(await readFile(join(plansPath, `${planId}.json`), 'utf8'));
  } catch {
    throw new WecomError('UNKNOWN_PLAN', '本机没有此计划记录；请先使用 wecom_plan_changes 生成计划。', { plan_id: planId });
  }
}


export async function saveExecution(entry: Record<string, unknown>) {
  const executionId = `e${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const value = { execution_id: executionId, timestamp: new Date().toISOString(), ...entry };
  await privateDirectory(executionsPath);
  const path = join(executionsPath, `${executionId}.json`);
  await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return { execution_id: executionId, path };
}

export async function listExecutions(documentId?: string, limit = 50) {
  try {
    const files = (await readdir(executionsPath)).filter(name => name.endsWith('.json')).sort().reverse();
    const entries: Record<string, unknown>[] = [];
    for (const file of files) {
      if (entries.length >= limit) break;
      try {
        const value = JSON.parse(await readFile(join(executionsPath, file), 'utf8'));
        if (documentId && value.document_id !== documentId) continue;
        entries.push(value);
      } catch { /* ignore unreadable log entries */ }
    }
    return entries;
  } catch {
    return [];
  }
}
