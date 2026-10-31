import { WecomError } from './errors.js';

interface CursorPosition {
  document_id: string; sheet_id: string; revision: number; offset: number;
  fields: string[]; include_text_fragments: boolean;
}
interface ReadCursor extends CursorPosition { v: 3 }
interface QueryCursor extends CursorPosition { v: 4; fingerprint: string; token: string }

function decodeCursor(input: string, documentId: string, sheetId: string, version: 3 | 4) {
  const label = version === 3 ? '分页' : '查询';
  let position: any;
  try { position = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')); }
  catch { throw new WecomError('INVALID_CURSOR', `${label}游标无法解析，请使用工具返回的完整 next_cursor。`); }
  if (position?.v !== version || position.document_id !== documentId || position.sheet_id !== sheetId
    || !Number.isSafeInteger(position.revision) || position.revision < 0
    || !Number.isSafeInteger(position.offset) || position.offset < 1
    || typeof position.include_text_fragments !== 'boolean'
    || !Array.isArray(position.fields) || !position.fields.length || position.fields.length > 500
    || !position.fields.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id))) {
    throw new WecomError('INVALID_CURSOR', `${label}游标无效或不属于此文档和子表，请使用工具返回的完整 next_cursor。`);
  }
  return position;
}

export function parseReadCursor(input: string, documentId: string, sheetId: string): ReadCursor {
  return decodeCursor(input, documentId, sheetId, 3);
}

export function parseQueryCursor(input: string, documentId: string, sheetId: string): QueryCursor {
  const position = decodeCursor(input, documentId, sheetId, 4);
  if (typeof position.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(position.fingerprint)
    || typeof position.token !== 'string' || !position.token.length) {
    throw new WecomError('INVALID_CURSOR', '查询游标缺少有效条件标识或服务端游标，请使用工具返回的完整 next_cursor。');
  }
  return position;
}
