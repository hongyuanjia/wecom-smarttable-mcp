import { WecomError } from './errors.js';
import type { NormalizedField } from './fields.js';

type Raw = Record<string, any>;

export interface MemberRef {
  namespace: string;
  id: string;
  name?: string;
}

export interface MemberCandidate extends MemberRef {
  departments?: string[];
  selectable?: boolean;
}

export type MemberResolutionStatus = 'unique' | 'ambiguous' | 'not_found' | 'invalid';

export interface MemberResolution {
  input: string;
  status: MemberResolutionStatus;
  candidates: MemberCandidate[];
  reason?: string;
}

export type MemberCellStatus = 'present' | 'not_returned' | 'unresolved';

export interface MemberCell {
  status: MemberCellStatus;
  members: MemberRef[];
  unresolved: { reason: string; raw: unknown }[];
  namespace_status: 'resolved' | 'missing' | 'partial';
}

function isObject(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function memberKey(member: Pick<MemberRef, 'namespace' | 'id'>): string {
  return `${member.namespace}\u0000${member.id}`;
}

export function validateMemberRef(input: unknown): { valid: true; member: MemberRef } | { valid: false; reason: string; index?: number } {
  if (!isObject(input)) return { valid: false, reason: '成员引用必须是对象。' };
  if (typeof input.namespace !== 'string' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(input.namespace)) {
    return { valid: false, reason: '成员引用缺少有效的身份命名空间。' };
  }
  if (typeof input.id !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,256}$/.test(input.id)) {
    return { valid: false, reason: '成员引用缺少有效的账号 ID。' };
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 256)) {
    return { valid: false, reason: '成员姓名只用于展示，必须是 0–256 字符的文本。' };
  }
  return { valid: true, member: { namespace: input.namespace, id: input.id, ...(input.name ? { name: input.name } : {}) } };
}

export interface MemberValidation {
  index: number;
  status: 'valid' | 'invalid' | 'duplicate' | 'namespace_unverified';
  member: MemberRef | null;
  reason?: string;
}

export function validateMemberReferences(refs: unknown[], options: { known_namespaces?: string[] } = {}): {
  results: MemberValidation[];
  valid: MemberRef[];
  invalid: number;
  duplicate: number;
  unresolved: number;
} {
  const seen = new Map<string, number>();
  const results: MemberValidation[] = refs.map((ref, index) => {
    const parsed = validateMemberRef(ref);
    if (!parsed.valid) return { index, status: 'invalid' as const, member: null, reason: parsed.reason };
    const key = memberKey(parsed.member);
    const previous = seen.get(key);
    if (previous !== undefined) return { index, status: 'duplicate' as const, member: parsed.member, reason: `与第 ${previous + 1} 项重复。` };
    seen.set(key, index);
    if (options.known_namespaces?.length && !options.known_namespaces.includes(parsed.member.namespace)) {
      return { index, status: 'namespace_unverified' as const, member: parsed.member,
        reason: '命名空间不在调用方声明的已知范围内；未验证前不能视为同一身份体系。' };
    }
    return { index, status: 'valid' as const, member: parsed.member };
  });
  const valid = results.filter(item => item.status === 'valid' && item.member).map(item => item.member!);
  return {
    results,
    valid,
    invalid: results.filter(item => item.status === 'invalid').length,
    duplicate: results.filter(item => item.status === 'duplicate').length,
    unresolved: results.filter(item => item.status === 'namespace_unverified').length,
  };
}

function normalizeName(value: string) {
  return value.trim().normalize('NFC');
}

// 姓名只用于查找和人工核对。唯一命中才返回身份；同名、多命名空间或不可选择一律暂停。
export function resolveMemberNames(names: string[], directory: MemberCandidate[]): MemberResolution[] {
  return names.map(name => {
    const normalized = normalizeName(name);
    if (!normalized) return { input: name, status: 'invalid', candidates: [], reason: '姓名不能为空。' };
    const matches = directory.filter(candidate => normalizeName(candidate.name || '') === normalized);
    const byIdentity = new Map<string, MemberCandidate>();
    for (const match of matches) {
      const parsed = validateMemberRef(match);
      if (!parsed.valid) continue;
      byIdentity.set(memberKey(parsed.member), { ...match, ...parsed.member });
    }
    const candidates = [...byIdentity.values()];
    if (!candidates.length) return { input: name, status: 'not_found', candidates: [] };
    if (candidates.length > 1) {
      return { input: name, status: 'ambiguous', candidates,
        reason: '同名或同一账号存在于多个身份命名空间；需要部门、单位或命名空间进一步区分。' };
    }
    if (candidates[0].selectable === false) {
      return { input: name, status: 'invalid', candidates, reason: '该候选成员当前不可选择。' };
    }
    return { input: name, status: 'unique', candidates };
  });
}

function memberFromItem(item: unknown): { member: MemberRef | null; reason?: string } {
  if (typeof item === 'string' && item) return { member: { namespace: 'wecom_uid', id: item } };
  if (!isObject(item)) return { member: null, reason: '成员项不是对象或账号字符串。' };
  const id = item.k1 ?? item['1'] ?? item.id ?? item.userid;
  const name = item.k2 ?? item['2'] ?? item.name ?? item.user_name;
  const namespace = item.k3 ?? item['3'] ?? item.namespace;
  if (typeof id !== 'string' || !id) return { member: null, reason: '成员项缺少账号 ID（姓名不能作为身份）。' };
  if (namespace !== undefined && typeof namespace !== 'string') return { member: null, reason: '成员项的命名空间不是字符串。' };
  return { member: {
    namespace: typeof namespace === 'string' && namespace ? namespace : 'wecom_uid',
    id,
    ...(typeof name === 'string' && name ? { name } : {}),
  } };
}

// 人员单元格的真实非空样本尚未取得；解析器只接受可证明的形状，其余明确返回 unresolved。
export function parseMemberCell(cell: Raw | undefined): MemberCell {
  if (!cell) return { status: 'not_returned', members: [], unresolved: [], namespace_status: 'missing' };
  const list = cell.k7 ?? cell['7'] ?? cell.k1 ?? cell['1'];
  if (!Array.isArray(list)) return { status: 'unresolved', members: [],
    unresolved: [{ reason: '人员单元格不是可识别的成员数组；没有按姓名字符串猜测身份。', raw: null }], namespace_status: 'missing' };
  const members: MemberRef[] = [];
  const unresolved: { reason: string; raw: unknown }[] = [];
  for (const item of list) {
    const parsed = memberFromItem(item);
    if (!parsed.member) unresolved.push({ reason: parsed.reason || '成员项无法解析。', raw: isObject(item) ? Object.keys(item) : null });
    else members.push(parsed.member);
  }
  const unique = [...new Map(members.map(member => [memberKey(member), member])).values()];
  const missingNamespace = unique.filter(member => !member.namespace).length;
  return {
    status: unresolved.length ? 'unresolved' : 'present',
    members: unique,
    unresolved,
    namespace_status: !unique.length ? 'missing' : missingNamespace === 0 ? 'resolved' : missingNamespace === unique.length ? 'missing' : 'partial',
  };
}

export type MemberUpdateMode = 'replace' | 'add' | 'remove';

export interface MemberUpdateInput {
  record_id: string;
  field_id: string;
  mode: MemberUpdateMode;
  members: { namespace: string; id: string; name?: string }[];
  current?: { namespace: string; id: string; name?: string }[];
}

export interface MemberUpdatePlan {
  record_id: string;
  field_id: string;
  mode: MemberUpdateMode;
  action: 'set' | 'clear' | 'noop';
  final_members: MemberRef[];
  added: MemberRef[];
  removed: MemberRef[];
  unchanged: MemberRef[];
  notes: string[];
}

function refsFrom(input: unknown[] | undefined, label: string): MemberRef[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new WecomError('INVALID_ARGUMENT', `${label}必须是成员引用数组。`);
  return input.map((ref, index) => {
    const parsed = validateMemberRef(ref);
    if (!parsed.valid) throw new WecomError('INVALID_ARGUMENT', `${label}第 ${index + 1} 项无效：${parsed.reason}`);
    return parsed.member;
  });
}

function dedupe(members: MemberRef[]) {
  return [...new Map(members.map(member => [memberKey(member), member])).values()];
}

// 单人/多人约束、去重、明确清空与“省略=保持原值”的语义都在这里落地。
// 原值未提供时拒绝 add/remove，避免把“未知”当成空值。
export function planMemberUpdates(multiple: boolean, updates: MemberUpdateInput[]): MemberUpdatePlan[] {
  if (!updates.length) throw new WecomError('INVALID_ARGUMENT', '至少需要一条成员单元格修改。');
  const records = new Set<string>();
  return updates.map(update => {
    if (records.has(update.record_id)) throw new WecomError('INVALID_ARGUMENT', '同一记录不能在一次请求中重复出现。', { record_id: update.record_id });
    records.add(update.record_id);
    const requested = dedupe(refsFrom(update.members, 'members'));
    if (!multiple && requested.length > 1) {
      throw new WecomError('MEMBER_MULTIPLE_NOT_ALLOWED', '此人员字段是单选，最多只能包含一个成员。', {
        field_id: update.field_id, record_id: update.record_id, requested: requested.length });
    }
    let finalMembers: MemberRef[];
    let notes: string[] = [];
    if (update.mode === 'replace') {
      finalMembers = requested;
    } else {
      if (update.current === undefined) {
        throw new WecomError('ORIGINAL_VALUE_REQUIRED', '追加或移除成员依赖原值；未读取当前人员单元格时拒绝执行。', {
          field_id: update.field_id, record_id: update.record_id, mode: update.mode });
      }
      const current = dedupe(refsFrom(update.current, 'current'));
      if (!multiple && current.length > 1) {
        throw new WecomError('MEMBER_UNRESOLVED', '原值超过单人选限制，不能安全计算追加/移除结果。', { record_id: update.record_id });
      }
      const currentKeys = new Set(current.map(member => memberKey(member)));
      const requestedKeys = new Set(requested.map(member => memberKey(member)));
      if (update.mode === 'add') {
        finalMembers = dedupe([...current, ...requested.filter(member => !currentKeys.has(memberKey(member)))]);
        notes = requested.filter(member => currentKeys.has(memberKey(member))).map(member => `${member.name || member.id} 已存在，未重复添加。`);
      } else {
        finalMembers = current.filter(member => !requestedKeys.has(memberKey(member)));
        const absent = requested.filter(member => !currentKeys.has(memberKey(member)));
        if (absent.length) notes = [`原值中不存在 ${absent.length} 个待移除成员，已按无变化处理。`];
      }
    }
    if (!multiple && finalMembers.length > 1) {
      throw new WecomError('MEMBER_MULTIPLE_NOT_ALLOWED', '计算结果超过单人选限制。', { record_id: update.record_id });
    }
    const ids = finalMembers.map(member => member.id);
    if (new Set(ids).size !== ids.length && new Set(finalMembers.map(member => member.namespace)).size > 1) {
      throw new WecomError('MEMBER_AMBIGUOUS', '结果中出现账号 ID 相同但命名空间不同的成员，无法确认是否同一人。', { record_id: update.record_id });
    }
    const before = update.mode === 'replace'
      ? (update.current ? dedupe(refsFrom(update.current, 'current')) : [])
      : dedupe(refsFrom(update.current, 'current'));
    if (update.mode === 'replace' && update.current === undefined) {
      notes = [...notes, '未提供原值；本次按替换语义处理，空 members 即明确清空。'];
    }
    const beforeKeys = new Set(before.map(member => memberKey(member)));
    const afterKeys = new Set(finalMembers.map(member => memberKey(member)));
    const added = finalMembers.filter(member => !beforeKeys.has(memberKey(member)));
    const removed = before.filter(member => !afterKeys.has(memberKey(member)));
    const unchanged = finalMembers.filter(member => beforeKeys.has(memberKey(member)));
    const action = finalMembers.length === 0 && (before.length > 0 || update.mode === 'replace')
      ? 'clear' : added.length || removed.length ? 'set' : 'noop';
    if (action === 'clear') notes = [...notes, '空 members 表示明确清空；省略整条更新才表示保持原值。'];
    return { record_id: update.record_id, field_id: update.field_id, mode: update.mode, action,
      final_members: finalMembers, added, removed, unchanged, notes };
  });
}

export function compareMemberCell(expected: MemberRef[], actual: MemberCell, multiple: boolean): {
  match: boolean;
  missing: MemberRef[];
  extra: MemberRef[];
  unresolved: boolean;
  not_returned: boolean;
  namespace_mismatch: boolean;
} {
  if (actual.status === 'unresolved') return { match: false, missing: [], extra: [], unresolved: true, not_returned: false, namespace_mismatch: false };
  if (actual.status === 'not_returned') return { match: false, missing: expected, extra: [], unresolved: false, not_returned: true, namespace_mismatch: false };
  if (!multiple && actual.members.length > 1) return { match: false, missing: [], extra: actual.members, unresolved: false, not_returned: false, namespace_mismatch: false };
  const exact = (member: MemberRef, other: MemberRef) =>
    member.namespace && other.namespace ? member.namespace === other.namespace && member.id === other.id : member.id === other.id;
  const missing = expected.filter(member => !actual.members.some(other => exact(member, other)));
  const extra = actual.members.filter(member => !expected.some(other => exact(other, member)));
  const namespaceMismatch = expected.some(member => member.namespace) && actual.members.some(member => !member.namespace);
  return { match: missing.length === 0 && extra.length === 0 && !namespaceMismatch,
    missing, extra, unresolved: false, not_returned: false, namespace_mismatch: namespaceMismatch };
}

export function memberFieldMultiple(field: NormalizedField): boolean {
  if (field.type !== 'USER') throw new WecomError('INVALID_ARGUMENT', '目标字段不是人员字段。', { field_id: field.id, type: field.type });
  if (field.attributes?.kind !== 'USER' || field.attributes.multiple === null) {
    throw new WecomError('MEMBER_UNRESOLVED', '人员字段的多选属性尚未识别，不能安全校验写入范围。', { field_id: field.id });
  }
  return field.attributes.multiple;
}
