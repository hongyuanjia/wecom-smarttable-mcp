import { WecomClient } from './client.js';
import { WecomError } from './errors.js';
import { cellsFor } from './protocol.js';
import {
  memberFieldMultiple, parseMemberCell, planMemberUpdates,
  type MemberCell, type MemberUpdateInput, type MemberUpdatePlan,
} from './members.js';
import { WecomWriter } from './writer.js';

export interface MemberWriteInput {
  url: string;
  sheetId: string;
  expectedRevision: number;
  notifyMembers: boolean;
  updates: MemberUpdateInput[];
  planId?: string;
}

function targetKey(recordId: string, fieldId: string) {
  return `${recordId}\u0000${fieldId}`;
}


async function readMemberCells(client: WecomClient, documentId: string, sheetId: string,
  targets: Map<string, Set<string>>) {
  const cells = new Map<string, MemberCell>();
  let revision: number | null = null;
  let total: number | null = null;
  let offset = 0;
  for (;;) {
    const page = await client.chunk(documentId, sheetId, offset, 200);
    if (revision === null) { revision = page.revision; total = page.total; }
    if (page.revision !== revision) throw new WecomError('DOCUMENT_CHANGED', '读取成员单元格期间表格版本变化，请重新读取。', { sheet_id: sheetId });
    for (const row of page.records) {
      const fields = targets.get(row.id);
      if (!fields) continue;
      const rawCells = cellsFor(row.raw);
      for (const fieldId of fields) cells.set(targetKey(row.id, fieldId), parseMemberCell(rawCells[fieldId]));
    }
    const next = page.end + 1;
    if (next >= page.total) break;
    if (next <= offset) throw new WecomError('INCOMPLETE_DATA', '读取成员单元格分页没有前进。', { sheet_id: sheetId });
    offset = next;
  }
  const missing = [];
  for (const [recordId, fields] of targets) {
    for (const fieldId of fields) if (!cells.has(targetKey(recordId, fieldId))) missing.push({ record_id: recordId, field_id: fieldId });
  }
  if (missing.length) throw new WecomError('UNKNOWN_RECORD', '成员写入包含不存在或不可读取的记录。', { missing });
  return { revision: revision!, total: total!, cells };
}

export async function updateMemberCells(client: WecomClient, input: MemberWriteInput, signal: AbortSignal) {
  if (input.notifyMembers !== false) {
    throw new WecomError('NOTIFICATION_CONTROL_UNAVAILABLE', '无法保证关闭成员通知，禁止写入。', { capability: 'member.cell.write' });
  }
  if (!input.updates.length) throw new WecomError('INVALID_ARGUMENT', '至少需要一条成员单元格修改。');

  const structure = await client.structure(input.url, input.sheetId);
  const sheet = structure.sheets.find(candidate => candidate.id === input.sheetId);
  if (!sheet) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此智能表格。', { sheet_id: input.sheetId });
  if (sheet.revision !== input.expectedRevision) {
    throw new WecomError('STALE_REVISION', '表格版本已变化；请重新读取并基于新内容决定修改，尚未写入。', {
      expected_revision: input.expectedRevision, current_revision: sheet.revision });
  }
  const fields = sheet.field_attributes;
  const fieldById = new Map(fields.map(field => [field.id, field]));

  const targets = new Map<string, Set<string>>();
  for (const update of input.updates) {
    const field = fieldById.get(update.field_id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '成员写入字段不存在或不可读取。', { field_id: update.field_id });
    if (field.type !== 'USER') throw new WecomError('INVALID_ARGUMENT', '目标字段不是人员字段。', { field_id: field.id, type: field.type });
    const notify = field.attributes?.kind === 'USER' ? field.attributes.notify_when_added : null;
    if (notify !== false) {
      throw new WecomError('NOTIFICATION_CONTROL_UNAVAILABLE',
        '无法确认该人员字段的通知已关闭，禁止写入。请先在字段设置中关闭“添加人员时通知”，或改用不通知的字段。', {
          capability: 'member.cell.write', field_id: field.id, field_name: field.name, notify_when_added: notify });
    }
    memberFieldMultiple(field);
    if (!targets.has(update.record_id)) targets.set(update.record_id, new Set());
    targets.get(update.record_id)!.add(update.field_id);
  }

  const before = await readMemberCells(client, structure.document_id, input.sheetId, targets);
  if (before.revision !== input.expectedRevision) {
    throw new WecomError('STALE_REVISION', '读取成员原值时表格版本已变化，尚未写入。', {
      expected_revision: input.expectedRevision, current_revision: before.revision });
  }

  // 同一字段的更新一起计算，便于执行单/多人约束与去重。
  const byField = new Map<string, MemberUpdateInput[]>();
  for (const update of input.updates) {
    if (!byField.has(update.field_id)) byField.set(update.field_id, []);
    byField.get(update.field_id)!.push(update);
  }
  const plans: (MemberUpdatePlan & { multiple: boolean })[] = [];
  for (const [fieldId, updates] of byField) {
    const field = fieldById.get(fieldId)!;
    const multiple = memberFieldMultiple(field);
    const normalized = updates.map(update => {
      const cell = before.cells.get(targetKey(update.record_id, fieldId));
      return {
        ...update,
        current: update.current ?? (cell?.status === 'present' ? cell.members : undefined),
      };
    });
    for (const plan of planMemberUpdates(multiple, normalized)) plans.push({ ...plan, multiple });
  }

  const changed = plans.filter(plan => plan.action !== 'noop');
  if (!changed.length) {
    return {
      status: 'verified', operation: 'update_member_cells', document_id: structure.document_id, sheet_id: sheet.id,
      previous_revision: before.revision, revision: before.revision, no_changes: true,
      notifications: { field_notify_enabled: false, operation_level: 'field_property_only' },
      updates: plans.map(plan => ({ record_id: plan.record_id, field_id: plan.field_id, action: plan.action,
        final_members: plan.final_members, changed: false })),
      limitations: ['所有目标单元格已经是请求的成员集合；没有提交写入。'],
    };
  }

  const writer = new WecomWriter(client, signal);
  const written = await writer.updateMemberCells(input.url, input.sheetId, input.expectedRevision,
    changed.map(plan => ({ record_id: plan.record_id, field_id: plan.field_id,
      uids: plan.final_members.map(member => member.id) })), input.planId);

  return {
    status: written.status,
    operation: 'update_member_cells',
    document_id: structure.document_id,
    sheet_id: sheet.id,
    previous_revision: written.previous_revision,
    revision: written.revision,
    notifications: { field_notify_enabled: false, operation_level: 'field_property_only' },
    updates: plans.map(plan => ({
      record_id: plan.record_id, field_id: plan.field_id, action: plan.action,
      final_members: plan.final_members, added: plan.added, removed: plan.removed,
      changed: plan.action !== 'noop', verified: true,
    })),
    limitations: [
      '通过 HTTP commitchanges 写入成员单元格，并按 uid 集合回读核对。',
      '字段级通知必须已关闭；不因写入成员自动邀请、分享或发消息。',
      '单/多人约束由字段配置决定；单次批量写入在一个请求内提交。',
      '跨用户并发修改不被本工具原子保护。',
    ],
  };
}
