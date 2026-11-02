import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaFromRaw } from '../dist/protocol.js';
import { normalizeFields } from '../dist/fields.js';

// 写入成功会记录 execution 日志；把日志目录指向临时目录，避免污染本机数据。
const dataDir = await mkdtemp(join(tmpdir(), 'wecom-writer-views-'));
process.env.WECOM_MCP_DATA_DIR = dataDir;
const { WecomWriter, summarizeFormulaSamples } = await import('../dist/writer.js');

test.after(() => rm(dataDir, { recursive: true, force: true }));

const rawFields = {
  f_text: { k30: '事项名称', k31: 1 },
  f_user: { k30: '承担人员', k31: 7, k7: { k1: false, k2: false } },
  f_status: { k30: '执行状态', k31: 17, k17: { k1: false, k2: true, k3: [{ k1: 'o_done', k2: '已完成', k3: 15 }] } },
  f_task: { k30: '所属任务编号', k31: 1 },
};
const fields = normalizeFields(schemaFromRaw({ k9: 'f_text', k4: [], k3: rawFields }));

function rawView(overrides = {}) {
  return {
    k30: 'v_edit', k31: '编辑视图', k32: 1, k33: 0, k34: 'owner_example', k35: 1, k37: [], k38: {},
    k1: {
      k1: [], k2: ['f_text', 'f_user', 'f_status'], k3: 1, k4: 1,
      k5: {
        f_text: { k1: 280, k2: false }, f_user: { k1: 160, k2: false },
        f_status: { k1: 120, k2: false }, f_task: { k1: 100, k2: true },
      },
      k6: true, k7: [], k8: { k1: 0, k2: [] }, k9: [], k10: false, k13: '',
      ...overrides,
    },
  };
}

function makeClient(initialView, { onWrite } = {}) {
  let view = structuredClone(initialView);
  let revision = 7;
  const posts = [];
  const schema = () => schemaFromRaw({ k9: 'f_text', k4: [structuredClone(view)], k3: rawFields });
  const chunk = () => ({ sheetId: 't_view', revision, total: 0, start: 0, end: 0,
    records: [], schema: schema(), workbook: [], raw: {} });
  const client = {
    context: {
      post: async (url, options) => {
        posts.push({ url, options });
        if (!onWrite) throw new Error('unexpected write');
        const body = await onWrite({ url, options, setView: next => { view = next; }, setRevision: next => { revision = next; } });
        return { ok: () => true, headers: () => ({ 'content-type': 'application/json' }),
          json: async () => body, dispose: async () => {} };
      },
      dispose: async () => {},
    },
    cookie: () => 'token_example',
    openDocument: async () => ({
      doc: { id: 'doc_example' },
      open: { clientVars: {
        privilegeAttribute: { can_edit: 1 },
        collab_client_vars: { dver: 'dver_example', pver: 1 },
        uin: 'u_example', userInfo: { fullName: '示例用户', corp_id: 1 }, optimizedVer: 4,
      } },
      directory: [{ id: 't_view', type: 'smartsheet' }],
    }),
    chunk: async () => chunk(),
    schema: async () => schema(),
  };
  return { client, posts, currentView: () => view };
}

const url = 'https://doc.example/smartsheet/s3_example';

test('列宽补丁已是当前原始宽度时不发 3024，返回 no_changes 且版本不变', async () => {
  const { client, posts } = makeClient(rawView());
  const writer = new WecomWriter(client, new AbortController().signal);
  const result = await writer.updateView(url, 't_view', 7, 'v_edit', { widths: { f_text: 280 } });
  assert.equal(result.status, 'verified');
  assert.equal(result.no_changes, true);
  assert.equal(result.revision, 7);
  assert.equal(posts.length, 0);
});

test('列宽真实变化只写请求且未请求列宽保持不变', async () => {
  const initial = rawView();
  const { client, posts } = makeClient(initial, {
    onWrite: async ({ options, setView, setRevision }) => {
      const payload = JSON.parse(options.form.data);
      const taskId = payload.respective[0].task_id;
      const nextRev = payload.common.curRev + 1;
      const next = structuredClone(initial);
      next.k1.k5.f_text.k1 = 300;
      setView(next);
      setRevision(nextRev);
      return { retcode: 0, Data: { respective: [{ commitId: taskId, subId: 't_view', revert: false, need: false,
        newRev: nextRev, changeset: payload.respective[0].changeset }] } };
    },
  });
  const writer = new WecomWriter(client, new AbortController().signal);
  const result = await writer.updateView(url, 't_view', 7, 'v_edit', { widths: { f_text: 300 } });
  assert.equal(result.no_changes, false);
  assert.equal(result.revision, 8);
  assert.equal(posts.length, 1);
  const payload = JSON.parse(posts[0].options.form.data);
  const commands = JSON.parse(payload.respective[0].changeset);
  assert.deepEqual(commands, [[{ t: 3024, v: 5, c: { '1': 't_view', '2': 'v_edit', '3': 'f_text', '4': { '1': 300 } }, r: -1, o: 0 }]]);
});

test('k1 声明的隐藏列与回读一致时不写 3018，显式空数组才产生清除写入', async () => {
  const initial = rawView({ k1: ['f_text', 'f_status'] });
  const noop = makeClient(initial);
  const writer = new WecomWriter(noop.client, new AbortController().signal);
  const result = await writer.updateView(url, 't_view', 7, 'v_edit',
    { hidden_fields: ['f_status', 'f_text'] });
  assert.equal(result.no_changes, true);
  assert.equal(result.revision, 7);
  assert.equal(noop.posts.length, 0, '声明来源 k1 已包含的隐藏列不应触发宽度标志来源的重复写入');

  const clearing = makeClient(initial);
  const clearingWriter = new WecomWriter(clearing.client, new AbortController().signal);
  await assert.rejects(() => clearingWriter.updateView(url, 't_view', 7, 'v_edit', { hidden_fields: [] }),
    error => error.code === 'WRITE_RESULT_UNKNOWN');
  assert.equal(clearing.posts.length, 1, '显式空数组必须发出清除隐藏列的写入');
  const payload = JSON.parse(clearing.posts[0].options.form.data);
  const commands = JSON.parse(payload.respective[0].changeset);
  assert.deepEqual(commands, [[{ t: 3018, v: 5, c: { '1': 't_view', '2': 'v_edit',
    '3': ['f_text', 'f_status'], '4': { '1': false } }, r: -1, o: 0 }]]);
});

test('公式写后核对：parse_error 与 pending 分开计数，逐条样本保留各自状态', () => {
  const summary = summarizeFormulaSamples([
    { record_id: 'r_present', status: 'present', text: '25%', result_type: 'PERCENT', error: null, parse_error: null },
    { record_id: 'r_pending', status: 'pending', text: '', result_type: null, error: null, parse_error: null },
    { record_id: 'r_bad', status: 'parse_error', text: '', result_type: null, error: null, parse_error: 'invalid_json' },
    { record_id: 'r_error', status: 'error', text: '计算错误', result_type: null,
      error: { type: 4, message: '计算错误', args: null }, parse_error: null },
  ]);
  assert.equal(summary.computed, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.parse_errors, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.sampled, 4);
  assert.deepEqual(summary.samples.map(sample => [sample.record_id, sample.status]), [
    ['r_present', 'present'], ['r_pending', 'pending'], ['r_bad', 'parse_error'], ['r_error', 'error'],
  ]);
  assert.deepEqual(summary.parse_error_details, [{ record_id: 'r_bad', parse_error: 'invalid_json' }]);
  assert.deepEqual(summary.error_details, [{ record_id: 'r_error', type: 4, message: '计算错误', args: null }]);
});

test('直接创建视图在写入前拒绝重复隐藏字段、非法列宽和未知字段', async () => {
  const { client, posts } = makeClient(rawView());
  const writer = new WecomWriter(client, new AbortController().signal);
  const base = { name: '新视图', type: 'grid' };
  for (const patch of [
    { ...base, hidden_fields: ['f_text', 'f_text'] },
    { ...base, hidden_fields: ['f_missing'] },
    { ...base, widths: { f_text: 0 } },
    { ...base, widths: { f_text: 140.5 } },
    { ...base, widths: { f_missing: 140 } },
  ]) {
    await assert.rejects(() => writer.createView(url, 't_view', 7, patch),
      error => ['INVALID_ARGUMENT', 'UNKNOWN_FIELD'].includes(error.code), JSON.stringify(patch));
  }
  assert.equal(posts.length, 0, '创建前校验失败不得发出任何写请求');
});
