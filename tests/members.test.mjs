import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMemberReferences, resolveMemberNames, parseMemberCell, planMemberUpdates, compareMemberCell, memberFieldMultiple } from '../dist/members.js';
import { presentRecord } from '../dist/protocol.js';

const ref = (namespace, id, name) => ({ namespace, id, ...(name ? { name } : {}) });

test('成员引用校验：结构、命名空间、重复项与未知命名空间分别报告', () => {
  const result = validateMemberReferences([
    ref('corp', 'u1', '甲'),
    { namespace: '', id: 'u2' },
    ref('corp', 'u1', '甲'),
    { namespace: 'corp', id: 'has space' },
    ref('other', 'u3', '乙'),
  ], { known_namespaces: ['corp'] });
  assert.deepEqual(result.results.map(item => item.status), ['valid', 'invalid', 'duplicate', 'invalid', 'namespace_unverified']);
  assert.equal(result.valid.length, 1);
  assert.equal(result.invalid, 2);
  assert.equal(result.duplicate, 1);
  assert.equal(result.unresolved, 1);
});

test('姓名匹配：唯一命中才返回身份；同名、不可选择与未找到都有明确状态', () => {
  const directory = [
    { namespace: 'corp', id: 'u1', name: '贾洪愿', departments: ['建环系'] },
    { namespace: 'corp', id: 'u2', name: '温世平' },
    { namespace: 'corp', id: 'u3', name: '同名' },
    { namespace: 'other', id: 'u4', name: '同名' },
    { namespace: 'corp', id: 'u5', name: '停用', selectable: false },
  ];
  const result = resolveMemberNames([' 贾洪愿 ', '同名', '停用', '不存在', ''], directory);
  assert.deepEqual(result.map(item => item.status), ['unique', 'ambiguous', 'invalid', 'not_found', 'invalid']);
  assert.equal(result[0].candidates[0].id, 'u1');
  assert.equal(result[1].candidates.length, 2);
  assert.equal(result[2].candidates[0].id, 'u5');
});

test('人员单元格解析：缺省、身份引用、姓名项和未知形状分别处理', () => {
  assert.equal(parseMemberCell(undefined).status, 'not_returned');
  const present = parseMemberCell({ k30: 7, k7: [{ k1: 'u1', k2: '甲', k3: 'corp' }, { k1: 'u1', k2: '甲', k3: 'corp' }] });
  assert.equal(present.status, 'present');
  assert.deepEqual(present.members, [{ namespace: 'corp', id: 'u1', name: '甲' }]);
  assert.equal(present.namespace_status, 'resolved');
  const rawUid = parseMemberCell({ k30: 7, k7: [{ k1: 'u1' }] });
  assert.deepEqual(rawUid.members, [{ namespace: 'wecom_uid', id: 'u1' }]);
  assert.equal(rawUid.namespace_status, 'resolved');
  const nameOnly = parseMemberCell({ k30: 7, k7: [{ k2: '只有姓名' }] });
  assert.equal(nameOnly.status, 'unresolved');
  assert.equal(nameOnly.members.length, 0);
  const unknown = parseMemberCell({ k30: 7, k7: { k1: 'u1' } });
  assert.equal(unknown.status, 'unresolved');
  assert.equal(JSON.stringify(unknown).includes('只有姓名'), false);
});

test('单/多人写入计划：去重、替换、追加、移除、明确清空与依赖原值', () => {
  assert.throws(() => planMemberUpdates(false, [{ record_id: 'r1', field_id: 'f1', mode: 'replace',
    members: [ref('corp', 'u1'), ref('corp', 'u2')] }]), error => error.code === 'MEMBER_MULTIPLE_NOT_ALLOWED');
  assert.throws(() => planMemberUpdates(false, [{ record_id: 'r1', field_id: 'f1', mode: 'add',
    members: [ref('corp', 'u1')] }]), error => error.code === 'ORIGINAL_VALUE_REQUIRED');

  const add = planMemberUpdates(false, [{ record_id: 'r1', field_id: 'f1', mode: 'add',
    members: [ref('corp', 'u1', '甲'), ref('corp', 'u1', '甲')], current: [] }]);
  assert.equal(add[0].action, 'set');
  assert.deepEqual(add[0].final_members, [ref('corp', 'u1', '甲')]);

  const replace = planMemberUpdates(true, [{ record_id: 'r1', field_id: 'f1', mode: 'replace',
    members: [ref('corp', 'u2'), ref('corp', 'u1')], current: [ref('corp', 'u1')] }]);
  assert.equal(replace[0].action, 'set');
  assert.deepEqual(replace[0].added, [ref('corp', 'u2')]);
  assert.deepEqual(replace[0].removed, []);

  const remove = planMemberUpdates(true, [{ record_id: 'r1', field_id: 'f1', mode: 'remove',
    members: [ref('corp', 'u1'), ref('corp', 'u9')], current: [ref('corp', 'u1'), ref('corp', 'u2')] }]);
  assert.equal(remove[0].action, 'set');
  assert.deepEqual(remove[0].final_members, [ref('corp', 'u2')]);
  assert.ok(remove[0].notes.some(note => note.includes('不存在')));

  const clear = planMemberUpdates(false, [{ record_id: 'r1', field_id: 'f1', mode: 'replace', members: [], current: [ref('corp', 'u1')] }]);
  assert.equal(clear[0].action, 'clear');
  assert.deepEqual(clear[0].final_members, []);

  assert.throws(() => planMemberUpdates(true, [{ record_id: 'r1', field_id: 'f1', mode: 'replace',
    members: [ref('corp', 'same'), ref('other', 'same')] }]), error => error.code === 'MEMBER_AMBIGUOUS');
});

test('回读按身份引用比较，忽略顺序与姓名，但报告 unresolved 和命名空间缺失', () => {
  const expected = [ref('corp', 'u1', '甲'), ref('corp', 'u2', '乙')];
  const actual = { status: 'present', members: [ref('corp', 'u2', '乙名'), ref('corp', 'u1', '甲名')],
    unresolved: [], namespace_status: 'resolved' };
  assert.equal(compareMemberCell(expected, actual, true).match, true);
  const missingNamespace = { status: 'present', members: [{ namespace: '', id: 'u1' }, { namespace: '', id: 'u2' }],
    unresolved: [], namespace_status: 'missing' };
  const comparison = compareMemberCell(expected, missingNamespace, true);
  assert.equal(comparison.match, false);
  assert.equal(comparison.namespace_mismatch, true);
  assert.equal(compareMemberCell(expected, { status: 'unresolved', members: [], unresolved: [], namespace_status: 'missing' }, true).unresolved, true);
  const absent = compareMemberCell([], { status: 'not_returned', members: [], unresolved: [], namespace_status: 'missing' }, false);
  assert.equal(absent.match, false);
  assert.equal(absent.not_returned, true);
});

test('人员字段读取同时保留原始值和语义化身份引用，不把姓名当作身份', () => {
  const schema = { fields: [{ id: 'f_user', name: '负责人', type_code: 7, type: 'USER', is_primary: false }], views: [], raw: {} };
  const row = { id: 'r1', raw: { k1: { f_user: { k30: 7, k7: [{ k1: 'u1', k2: '甲', k3: 'corp' }] } } } };
  const value = presentRecord({ sheetId: 's1', raw: {} }, schema, row, 'doc', ['f_user']).fields.f_user;
  assert.equal(value.status, 'present');
  assert.deepEqual(value.members, [{ namespace: 'corp', id: 'u1', name: '甲' }]);
  assert.equal(value.namespace_status, 'resolved');
  assert.deepEqual(value.value, [{ k1: 'u1', k2: '甲', k3: 'corp' }]);

  const nameOnly = { id: 'r2', raw: { k1: { f_user: { k30: 7, k7: [{ k2: '只有姓名' }] } } } };
  const unresolved = presentRecord({ sheetId: 's1', raw: {} }, schema, nameOnly, 'doc', ['f_user']).fields.f_user;
  assert.equal(unresolved.status, 'unresolved');
  assert.deepEqual(unresolved.members, []);
  assert.equal(unresolved.namespace_status, 'missing');
});

test('人员字段属性未识别时拒绝推断单/多人', () => {
  assert.throws(() => memberFieldMultiple({ id: 'f1', type: 'USER', attributes: { kind: 'USER', multiple: null } }),
    error => error.code === 'MEMBER_UNRESOLVED');
  assert.equal(memberFieldMultiple({ id: 'f1', type: 'USER', attributes: { kind: 'USER', multiple: true } }), true);
});
