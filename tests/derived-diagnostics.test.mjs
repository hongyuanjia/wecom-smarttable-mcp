import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseDerivedResult, presentRecord } from '../dist/protocol.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const formulaSchema = { fields: [{ id: 'f_derived', name: '派生', type_code: 19, type: 'FORMULA', is_primary: false }], views: [], raw: {} };
const row = cell => ({ id: 'r1', raw: { k1: cell ? { f_derived: cell } : {} } });

function present(cell, context) {
  return presentRecord({ sheetId: 's_diag', raw: {}, start: 0, end: 0 }, formulaSchema, row(cell), 'id_diag_document', ['f_derived'], false, context)
    .fields.f_derived;
}

test('解析失败诊断记录来源、原始类型、长度、哈希与失败位置', () => {
  const raw = '[1,2';
  const result = parseDerivedResult({ k30: 19, k36: { k1: raw, k2: true } });
  assert.equal(result.status, 'parse_error');
  assert.equal(result.parse_error, 'invalid_json');
  assert.equal(result.value, null);
  assert.equal(result.computed_result, null);
  const diagnostics = result.parse_diagnostics;
  assert.equal(diagnostics.source, 'k36.k1');
  assert.equal(diagnostics.failure, 'invalid_json');
  assert.equal(diagnostics.raw_type, 'string');
  assert.equal(diagnostics.raw_length, raw.length);
  assert.equal(diagnostics.raw_sha256, sha256(raw));
  assert.equal(diagnostics.failure_position, 4);
  assert.equal(diagnostics.failure_line, 1);
  assert.equal(diagnostics.failure_column, 5);
  assert.equal(diagnostics.raw_content_included, false);
  assert.equal(typeof diagnostics.build_id, 'string');
  assert.ok(diagnostics.build_id.length > 0);
});

test('默认诊断不含原始片段，显式本地诊断模式才限长脱敏保存', () => {
  const tokenKey = ['access', 'token'].join('_');
  const raw = `{"sourceType":19,"data":[{"text":"https://example.invalid/report?sid=abc123&${tokenKey}=secret","name":"张三"},{"text":"${'a '.repeat(200)}"}]}broken`;
  const cell = { k30: 19, k36: { k1: raw, k2: true } };

  delete process.env.WECOM_MCP_DIAGNOSTICS;
  const defaultResult = parseDerivedResult(cell);
  assert.equal(defaultResult.parse_diagnostics.raw_content_included, false);
  assert.equal('raw_snippet' in defaultResult.parse_diagnostics, false);
  const defaultJson = JSON.stringify(defaultResult);
  assert.equal(defaultJson.includes('sourceType'), false);
  assert.equal(defaultJson.includes('example.invalid'), false);

  process.env.WECOM_MCP_DIAGNOSTICS = '1';
  try {
    const optedIn = parseDerivedResult(cell);
    const snippet = optedIn.parse_diagnostics.raw_snippet;
    assert.ok(snippet, '显式诊断模式下应包含片段');
    assert.equal(optedIn.parse_diagnostics.raw_content_included, true);
    assert.ok(snippet.text.length <= snippet.limit);
    assert.ok(snippet.limit > 0 && snippet.limit <= 200);
    assert.equal(snippet.truncated, true);
    assert.equal(snippet.redacted, true);
    assert.equal(snippet.text.includes('example.invalid'), false);
    assert.equal(snippet.text.includes('abc123'), false);
    assert.equal(snippet.text.includes('secret'), false);
    assert.equal(snippet.text.includes('张三'), false);
    assert.ok(snippet.text.includes('[url]'));
  } finally {
    delete process.env.WECOM_MCP_DIAGNOSTICS;
  }
});

test('整表读取在字段结果中记录读取路径、revision、文档/子表与字段上下文', () => {
  const result = present({ k30: 19, k36: { k1: '{', k2: true } },
    { read_path: 'whole_table', revision: 433 });
  const diagnostics = result.parse_diagnostics;
  assert.equal(result.status, 'parse_error');
  assert.equal(diagnostics.read_path, 'whole_table');
  assert.equal(diagnostics.revision, 433);
  assert.equal(diagnostics.document_id, 'id_diag_document');
  assert.equal(diagnostics.sheet_id, 's_diag');
  assert.equal(diagnostics.field_id, 'f_derived');
  assert.equal(diagnostics.field_type, 'FORMULA');
  assert.equal(diagnostics.field_type_code, 19);

  const query = present({ k30: 19, k36: { k1: '{', k2: true } }, { read_path: 'query', revision: 545 });
  assert.equal(query.parse_diagnostics.read_path, 'query');
  assert.equal(query.parse_diagnostics.revision, 545);

  const view = present({ k30: 19, k36: { k1: '{', k2: true } }, { read_path: 'view', revision: 546 });
  assert.equal(view.parse_diagnostics.read_path, 'view');
  assert.equal(view.parse_diagnostics.revision, 546);
});

test('诊断中的 formatter 上下文与结果字段使用同一数字归一化', () => {
  const snake = parseDerivedResult({ k30: 19, k3601: { formatter_type: '14' } });
  assert.equal(snake.parse_diagnostics.failure, 'missing_data');
  assert.equal(snake.parse_diagnostics.formatter_type, 14);
  const camel = parseDerivedResult({ k30: 19, k3601: { formatterType: '28' } });
  assert.equal(camel.parse_diagnostics.formatter_type, 28);
  const nonNumeric = parseDerivedResult({ k30: 19, k3601: { formatter_type: 'percent' } });
  assert.equal(nonNumeric.parse_diagnostics.formatter_type, null);
});

test('旧接口 k3601 的字符串与对象失败也分别记录来源和原始类型', () => {
  const legacyString = parseDerivedResult({ k30: 19, k3601: '{' });
  assert.equal(legacyString.parse_diagnostics.source, 'k3601');
  assert.equal(legacyString.parse_diagnostics.raw_type, 'string');

  const legacyObject = parseDerivedResult({ k30: 19, k3601: { sourceType: 19 } });
  assert.equal(legacyObject.status, 'parse_error');
  assert.equal(legacyObject.parse_error, 'missing_data');
  assert.equal(legacyObject.parse_diagnostics.failure, 'missing_data');
  assert.equal(legacyObject.parse_diagnostics.raw_type, 'object');
  assert.equal(legacyObject.parse_diagnostics.failure_position, null);

  const legacyArray = parseDerivedResult({ k30: 19, k3601: [1, 2] });
  assert.equal(legacyArray.parse_diagnostics.raw_type, 'array');
});

test('解析失败仍与空结果、未返回、待计算、计算错误保持可区分状态', () => {
  const cell = { k30: 19, k36: { k1: 'not json', k2: true } };
  const parseFailure = parseDerivedResult(cell);
  assert.equal(parseFailure.status, 'parse_error');
  assert.notEqual(parseFailure.status, 'empty');
  assert.notEqual(parseFailure.status, 'present');
  assert.equal(parseFailure.value, null);

  const empty = parseDerivedResult({ k30: 19, k36: { k1: JSON.stringify({ sourceType: 19, data: [] }), k2: true } });
  assert.equal(empty.status, 'empty');
  assert.equal('parse_diagnostics' in empty, false);
  assert.equal(parseDerivedResult({ k30: 19, k36: { k2: false } }).status, 'pending');
  assert.equal(present().status, 'not_returned');
  const calculationError = parseDerivedResult({ k30: 19, k36: { k1: JSON.stringify({ sourceType: 19,
    data: [{ text: '计算错误', isError: true, errorType: 4 }] }), k2: true } });
  assert.equal(calculationError.status, 'error');
});

test('首选来源成功时另一来源解析失败仍记录独立诊断', () => {
  const result = parseDerivedResult({
    k30: 19,
    k36: { k1: JSON.stringify({ sourceType: 19, data: [{ text: '1', number: 1, formatterType: 2 }] }), k2: true },
    k3601: '{',
  }, { read_path: 'query', revision: 7 });
  assert.equal(result.status, 'present');
  assert.equal(result.value, 1);
  assert.equal(result.alternate_parse_error.parse_diagnostics.source, 'k3601');
  assert.equal(result.alternate_parse_error.parse_diagnostics.read_path, 'query');
  assert.equal(result.alternate_parse_error.parse_diagnostics.revision, 7);
});

test('默认诊断不含凭据、链接或完整文档内容', () => {
  const sidKey = ['wedoc', 'sid'].join('_');
  const tokenKey = ['access', 'token'].join('_');
  const signatureKey = ['sign', 'ature'].join('');
  const raw = JSON.stringify({ sourceType: 19, cookie: `${sidKey}=secret-cookie`, [tokenKey]: 'secret-token',
    data: [{ text: `https://example.invalid/signed?${signatureKey}=abc`, name: '张三', number: 25 }] });
  const result = parseDerivedResult({ k30: 19, k36: { k1: `${raw}broken`, k2: true } });
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes('secret-cookie'), false);
  assert.equal(rendered.includes('secret-token'), false);
  assert.equal(rendered.includes('example.invalid'), false);
  assert.equal(rendered.includes('张三'), false);
  assert.equal(/wedoc_sid|access_token|signature=/.test(rendered), false);
});
