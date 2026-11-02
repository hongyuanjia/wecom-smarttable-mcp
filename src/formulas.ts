import { WecomError } from './errors.js';
import type { NormalizedField } from './fields.js';

type Raw = Record<string, any>;

export const SHANGHAI_TIMEZONE = 'Asia/Shanghai';
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function isObject(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function shanghaiDayKey(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return null;
    return DAY_FORMAT.format(new Date(value));
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return DAY_FORMAT.format(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // 带 Z 或显式时区偏移的字符串是绝对时刻，先按绝对时刻转换。
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : DAY_FORMAT.format(new Date(parsed));
    }
    // 表内日期值按东八区本地时间书写；纯日期直接取自然日，不经过可能漂移的 Date 解析。
    const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(trimmed);
    if (local) {
      const [, year, month, day, hour, minute, second] = local;
      const monthNumber = Number(month);
      const dayNumber = Number(day);
      if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
      if (hour === undefined) return `${year}-${month}-${day}`;
      const ms = Date.UTC(Number(year), monthNumber - 1, dayNumber,
        Number(hour) - 8, Number(minute), Number(second || 0));
      return DAY_FORMAT.format(new Date(ms));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : DAY_FORMAT.format(new Date(parsed));
  }
  return null;
}

export function todayInShanghai(now: number | Date = Date.now()): string {
  return DAY_FORMAT.format(typeof now === 'number' ? new Date(now) : now);
}

export type DueStatus = 'COMPLETED' | 'DATE_PENDING' | 'STATUS_PENDING' | 'OVERDUE' | 'DUE_TODAY' | 'NOT_DUE';

export interface DueStatusResult {
  code: DueStatus;
  label: string;
  reason: string;
  due_day: string | null;
  today: string;
}

// 业务伪代码的逐分支落地：已完成 → 日期为空 → 状态为空 → 逾期 → 今日 → 未到期。
export function dueStatus(input: { status?: unknown; due_date?: unknown }, options: {
  completed_status?: string;
  today?: string | number | Date;
} = {}): DueStatusResult {
  const completedStatus = options.completed_status ?? '已完成';
  const today = typeof options.today === 'string' ? options.today : todayInShanghai(options.today ?? Date.now());
  const dueDay = shanghaiDayKey(input.due_date);
  const status = typeof input.status === 'string' ? input.status.trim() : input.status == null ? '' : String(input.status).trim();
  const base = { due_day: dueDay, today };
  if (status === completedStatus) return { code: 'COMPLETED', label: '已完成', reason: '执行状态为已完成。', ...base };
  if (!dueDay) return { code: 'DATE_PENDING', label: '待确定日期', reason: '计划完成日期为空或不是可识别的自然日。', ...base };
  if (!status) return { code: 'STATUS_PENDING', label: '待核实状态', reason: '执行状态为空，无法判断是否完成。', ...base };
  if (dueDay < today) return { code: 'OVERDUE', label: '已逾期', reason: '计划完成日期早于今天。', ...base };
  if (dueDay === today) return { code: 'DUE_TODAY', label: '今日到期', reason: '计划完成日期等于今天。', ...base };
  return { code: 'NOT_DUE', label: '未到期', reason: '计划完成日期晚于今天。', ...base };
}

export function completionRate(completed: unknown, total: unknown): {
  status: 'value' | 'empty';
  value: number | null;
  display: string | null;
  completed: number | null;
  total: number | null;
  note?: string;
} {
  const completedNumber = typeof completed === 'number' && Number.isInteger(completed) && completed >= 0 ? completed : null;
  const totalNumber = typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null;
  if (completedNumber === null || totalNumber === null) {
    return { status: 'empty', value: null, display: null, completed: completedNumber, total: totalNumber,
      note: '计数必须是 0 或正整数。' };
  }
  if (totalNumber === 0) return { status: 'empty', value: null, display: null, completed: completedNumber, total: totalNumber,
    note: '分母为 0，返回空值而不是 0% 或 100%。' };
  if (completedNumber > totalNumber) return { status: 'value', value: completedNumber / totalNumber,
    display: `${(completedNumber / totalNumber * 100).toFixed(1)}%`, completed: completedNumber, total: totalNumber,
    note: '已完成数大于年度事项数；未自动截断，需核对来源数据。' };
  return { status: 'value', value: completedNumber / totalNumber,
    display: `${(completedNumber / totalNumber * 100).toFixed(1)}%`, completed: completedNumber, total: totalNumber };
}

export const BINARY_OPERATORS = ['add', 'subtract', 'multiply', 'divide', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or'] as const;
export const UNARY_OPERATORS = ['not', 'negate'] as const;
export const FORMULA_CALLS: Record<string, { min: number; max: number }> = {
  if: { min: 2, max: 3 }, is_empty: { min: 1, max: 1 }, coalesce: { min: 1, max: 10 },
  count: { min: 1, max: 1 }, count_non_empty: { min: 1, max: 1 }, count_equals: { min: 2, max: 2 },
  date_diff_days: { min: 2, max: 2 }, concat: { min: 1, max: 10 }, round: { min: 1, max: 2 },
  percent: { min: 2, max: 2 }, today: { min: 0, max: 0 },
};
export type BinaryOperator = typeof BINARY_OPERATORS[number];
export type UnaryOperator = typeof UNARY_OPERATORS[number];
export type FormulaExpression =
  | { kind: 'field'; field_id: string }
  | { kind: 'constant'; value: string | number | boolean | null }
  | { kind: 'binary'; operator: BinaryOperator; left: FormulaExpression; right: FormulaExpression }
  | { kind: 'unary'; operator: UnaryOperator; operand: FormulaExpression }
  | { kind: 'call'; name: string; args: FormulaExpression[] };

export interface FormulaValidation {
  status: 'valid' | 'invalid';
  errors: { code: string; message: string; path: string }[];
  dependencies: string[];
  inferred_type: 'text' | 'number' | 'boolean' | 'date' | 'mixed' | 'unknown';
  nodes: number;
}

// 只接受结构化表达式；不接受任意字符串公式，也不使用 eval。
export function validateFormulaExpression(expression: unknown, fields: NormalizedField[]): FormulaValidation {
  const byId = new Map(fields.map(field => [field.id, field]));
  const errors: FormulaValidation['errors'] = [];
  const dependencies = new Set<string>();
  let nodes = 0;
  const walk = (node: unknown, path: string, depth: number): FormulaValidation['inferred_type'] => {
    nodes += 1;
    if (nodes > 200) { errors.push({ code: 'FORMULA_TOO_LARGE', message: '表达式节点超过 200 个。', path }); return 'unknown'; }
    if (depth > 20) { errors.push({ code: 'FORMULA_TOO_DEEP', message: '表达式嵌套超过 20 层。', path }); return 'unknown'; }
    if (!isObject(node)) { errors.push({ code: 'FORMULA_INVALID', message: '表达式节点必须是结构对象。', path }); return 'unknown'; }
    switch (node.kind) {
      case 'field': {
        if (typeof node.field_id !== 'string') { errors.push({ code: 'FORMULA_INVALID', message: '字段引用缺少 field_id。', path }); return 'unknown'; }
        const field = byId.get(node.field_id);
        if (!field) { errors.push({ code: 'UNKNOWN_FIELD', message: '公式引用了不存在或不可读取的字段。', path: `${path}.field_id` }); return 'unknown'; }
        dependencies.add(field.id);
        if (field.type === 'TEXT' || field.type === 'SINGLE_SELECT' || field.type === 'MULTIPLE_SELECT' || field.type === 'PHONE' || field.type === 'EMAIL') return 'text';
        if (field.type === 'CHECKBOX') return 'boolean';
        if (field.type === 'DATE_TIME' || field.type === 'CREATED_TIME' || field.type === 'MODIFIED_TIME') return 'date';
        if (['NUMBER', 'PROGRESS'].includes(field.type)) return 'number';
        return 'mixed';
      }
      case 'constant': {
        const value = node.value;
        if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
          errors.push({ code: 'FORMULA_INVALID', message: '常量只能是文本、数字、布尔值或 null。', path });
          return 'unknown';
        }
        return value === null ? 'unknown' : typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : 'boolean';
      }
      case 'binary': {
        if (!BINARY_OPERATORS.includes(node.operator)) { errors.push({ code: 'FORMULA_INVALID', message: '不支持的二元运算符。', path }); return 'unknown'; }
        const left = walk(node.left, `${path}.left`, depth + 1);
        const right = walk(node.right, `${path}.right`, depth + 1);
        if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or'].includes(node.operator)) return 'boolean';
        if (['add', 'subtract', 'multiply', 'divide'].includes(node.operator)) {
          if (node.operator === 'add' && left === 'text' && right === 'text') return 'text';
          if (left !== 'number' || right !== 'number') {
            errors.push({ code: 'FORMULA_TYPE_MISMATCH', message: '算术运算两侧必须是数字。', path });
          }
          return 'number';
        }
        return 'unknown';
      }
      case 'unary': {
        if (!UNARY_OPERATORS.includes(node.operator)) { errors.push({ code: 'FORMULA_INVALID', message: '不支持的一元运算符。', path }); return 'unknown'; }
        const operand = walk(node.operand, `${path}.operand`, depth + 1);
        if (node.operator === 'not' && operand !== 'boolean') errors.push({ code: 'FORMULA_TYPE_MISMATCH', message: 'not 需要布尔操作数。', path });
        return node.operator === 'not' ? 'boolean' : 'number';
      }
      case 'call': {
        if (typeof node.name !== 'string' || !FORMULA_CALLS[node.name]) { errors.push({ code: 'FORMULA_INVALID', message: '不支持的公式函数。', path }); return 'unknown'; }
        if (!Array.isArray(node.args) || node.args.length < FORMULA_CALLS[node.name].min || node.args.length > FORMULA_CALLS[node.name].max) {
          errors.push({ code: 'FORMULA_ARITY', message: `函数 ${node.name} 的参数数量无效。`, path });
          return 'unknown';
        }
        const types = node.args.map((arg, index) => walk(arg, `${path}.args[${index}]`, depth + 1));
        if (['count', 'count_non_empty', 'count_equals', 'date_diff_days'].includes(node.name) && node.args[0]?.kind !== 'field') {
          errors.push({ code: 'FORMULA_INVALID', message: `函数 ${node.name} 的第一个参数必须是字段。`, path });
        }
        if (node.name === 'count_equals' && node.args[0]?.kind === 'field') {
          const source = fields.find(field => field.id === (node.args[0] as { field_id: string }).field_id);
          if (source?.type === 'TEXT') errors.push({ code: 'UNSUPPORTED_FORMULA',
            message: '文本字段的 COUNTIF 会被服务端拒绝；请改用数值或选项字段。', path });
        }
        switch (node.name) {
          case 'if': return types[1] || 'unknown';
          case 'is_empty': return 'boolean';
          case 'coalesce': return types.find(type => type !== 'unknown') || 'unknown';
          case 'count': case 'count_non_empty': case 'count_equals': case 'date_diff_days': return 'number';
          case 'concat': return 'text';
          case 'round': case 'percent': return 'number';
          case 'today': return 'date';
          default: return 'unknown';
        }
      }
      default:
        errors.push({ code: 'FORMULA_INVALID', message: '未知的表达式节点类型。', path });
        return 'unknown';
    }
  };
  const inferred = walk(expression, '$', 0);
  return { status: errors.length ? 'invalid' : 'valid', errors, dependencies: [...dependencies], inferred_type: inferred, nodes };
}

export interface FormulaDefinition {
  expression: FormulaExpression;
  result_type: 'text' | 'number' | 'date' | 'boolean';
  format?: string;
  dependencies?: string[];
}

export function validateFormulaDefinition(definition: unknown, fields: NormalizedField[]): FormulaValidation & {
  result_type: string | null;
  format: string | null;
  config_status: 'valid' | 'invalid';
  calculation_status: 'pending' | 'unavailable';
  calculation_note: string;
} {
  if (!isObject(definition)) throw new WecomError('FORMULA_INVALID', '公式定义必须是结构化对象。');
  const validation = validateFormulaExpression(definition.expression, fields);
  const errors = [...validation.errors];
  if (!['text', 'number', 'date', 'boolean'].includes(definition.result_type as string)) {
    errors.push({ code: 'FORMULA_INVALID', message: 'result_type 必须是 text/number/date/boolean。', path: '$.result_type' });
  } else if (validation.inferred_type !== 'unknown' && validation.inferred_type !== 'mixed'
    && validation.inferred_type !== definition.result_type) {
    errors.push({ code: 'FORMULA_TYPE_MISMATCH', message: `表达式推断类型 ${validation.inferred_type} 与声明的 ${definition.result_type} 不一致。`, path: '$.result_type' });
  }
  if (definition.dependencies !== undefined) {
    if (!Array.isArray(definition.dependencies) || definition.dependencies.some(id => typeof id !== 'string')) {
      errors.push({ code: 'FORMULA_INVALID', message: 'dependencies 必须是字段 ID 数组。', path: '$.dependencies' });
    } else {
      const declared = new Set(definition.dependencies);
      const actual = new Set(validation.dependencies);
      if (declared.size !== actual.size || [...declared].some(id => !actual.has(id))) {
        errors.push({ code: 'FIELD_DEPENDENCY_CONFLICT', message: '声明的依赖与表达式实际引用不一致。', path: '$.dependencies' });
      }
    }
  }
  if (definition.format !== undefined && typeof definition.format !== 'string') {
    errors.push({ code: 'FORMULA_INVALID', message: 'format 必须是文本。', path: '$.format' });
  }
  return { ...validation, status: errors.length ? 'invalid' : 'valid', errors,
    result_type: typeof definition.result_type === 'string' ? definition.result_type : null,
    format: typeof definition.format === 'string' ? definition.format : null,
    config_status: errors.length ? 'invalid' : 'valid',
    calculation_status: 'unavailable',
    calculation_note: '提供方公式计算状态与结果读取尚未验证；配置有效不等于计算已验证。' };
}

// 受限解释器只执行结构化节点，供本地测试和业务规则核对；它不会执行用户提供的任意文本。
export function evaluateFormula(expression: unknown, values: Record<string, unknown>): unknown {
  const evalNode = (node: any): unknown => {
    if (!isObject(node)) return null;
    switch (node.kind) {
      case 'field': return values[node.field_id] ?? null;
      case 'constant': return node.value ?? null;
      case 'binary': {
        const left = evalNode(node.left) as any;
        const right = evalNode(node.right) as any;
        switch (node.operator) {
          case 'add': return typeof left === 'string' && typeof right === 'string' ? left + right : Number(left) + Number(right);
          case 'subtract': return Number(left) - Number(right);
          case 'multiply': return Number(left) * Number(right);
          case 'divide': return Number(right) === 0 ? null : Number(left) / Number(right);
          case 'eq': return left === right;
          case 'ne': return left !== right;
          case 'gt': return left > right;
          case 'gte': return left >= right;
          case 'lt': return left < right;
          case 'lte': return left <= right;
          case 'and': return Boolean(left) && Boolean(right);
          case 'or': return Boolean(left) || Boolean(right);
          default: return null;
        }
      }
      case 'unary': {
        const operand = evalNode(node.operand);
        return node.operator === 'not' ? !operand : -Number(operand);
      }
      case 'call': {
        const args = (node.args || []).map(evalNode) as any[];
        switch (node.name) {
          case 'if': return args[0] ? args[1] : args[2] ?? null;
          case 'is_empty': return args[0] === null || args[0] === undefined || args[0] === '' || (Array.isArray(args[0]) && !args[0].length);
          case 'coalesce': return args.find(value => value !== null && value !== undefined && value !== '') ?? null;
          case 'count': return Array.isArray(args[0]) ? args[0].length : 0;
          case 'count_non_empty': return Array.isArray(args[0]) ? args[0].filter(value => value !== null && value !== undefined && value !== '').length : 0;
          case 'count_equals': return Array.isArray(args[0]) ? args[0].filter(value => value === args[1]).length : 0;
          case 'date_diff_days': {
            const left = shanghaiDayKey(args[0]);
            const right = shanghaiDayKey(args[1]);
            if (!left || !right) return null;
            return Math.round((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
          }
          case 'concat': return args.map(value => value == null ? '' : String(value)).join('');
          case 'round': {
            const digits = args.length > 1 ? Number(args[1]) : 0;
            const factor = 10 ** digits;
            return Math.round(Number(args[0]) * factor) / factor;
          }
          case 'percent': return Number(args[1]) === 0 ? null : Number(args[0]) / Number(args[1]);
          case 'today': return todayInShanghai();
          default: return null;
        }
      }
      default: return null;
    }
  };
  return evalNode(expression);
}

export function annualCounts(records: { source_subtask_number?: unknown; status?: unknown }[], subtaskNumber: string, completedStatus = '已完成') {
  const matched = records.filter(record => typeof record.source_subtask_number === 'string'
    && record.source_subtask_number.trim() === subtaskNumber);
  const completed = matched.filter(record => typeof record.status === 'string' && record.status.trim() === completedStatus).length;
  return { total: matched.length, completed, rate: completionRate(completed, matched.length) };
}

// 网页公式编辑器的真实存储结构：文本片段 {1:1,2:text} 与字段引用 {1:2,3:field_id} 交替。
// 字段名不写入文本片段；必须用字段 token，否则服务端会返回“不识别的内容”。
export interface ProviderFormulaToken { '1': 1 | 2; '2'?: string; '3'?: string }

export const PROVIDER_FORMULA_CALLS = new Set(['if', 'is_empty', 'today', 'count', 'count_non_empty', 'count_equals', 'date_diff_days', 'concat', 'round']);

const PROVIDER_CALLS: Record<string, string> = {
  if: 'IF', is_empty: 'ISBLANK', today: 'TODAY', count: 'COUNT', count_non_empty: 'COUNTA',
  count_equals: 'COUNTIF', date_diff_days: 'DATEDIF', concat: 'CONCATENATE', round: 'ROUND',
};

function quoteFormulaText(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function encodeProviderFormula(expression: FormulaExpression, fields: NormalizedField[]): ProviderFormulaToken[] {
  const byId = new Map(fields.map(field => [field.id, field]));
  const tokens: ProviderFormulaToken[] = [];
  let text = '';
  const flush = () => { if (text) { tokens.push({ '1': 1, '2': text }); text = ''; } };
  const walk = (node: FormulaExpression): void => {
    switch (node.kind) {
      case 'field': {
        if (!byId.has(node.field_id)) throw new WecomError('UNKNOWN_FIELD', '公式引用了不存在或不可读取的字段。', { field_id: node.field_id });
        flush();
        tokens.push({ '1': 2, '3': node.field_id });
        return;
      }
      case 'constant': {
        if (node.value === null) throw new WecomError('UNSUPPORTED_FORMULA', '公式暂不支持 null 常量；请改用空字符串或 ISBLANK。');
        if (typeof node.value === 'string') text += quoteFormulaText(node.value);
        else if (typeof node.value === 'boolean') text += node.value ? 'TRUE' : 'FALSE';
        else text += String(node.value);
        return;
      }
      case 'binary': {
        const operator: Record<string, string> = {
          add: '+', subtract: '-', multiply: '*', divide: '/', eq: '==', ne: '!=',
          gt: '>', gte: '>=', lt: '<', lte: '<=',
        };
        if (node.operator === 'and' || node.operator === 'or') {
          text += node.operator === 'and' ? 'AND(' : 'OR(';
          walk(node.left); text += ','; walk(node.right); text += ')';
          return;
        }
        const symbol = operator[node.operator];
        if (!symbol) throw new WecomError('UNSUPPORTED_FORMULA', '此二元运算符尚未验证公式编码。', { operator: node.operator });
        text += '('; walk(node.left); text += symbol; walk(node.right); text += ')';
        return;
      }
      case 'unary': {
        if (node.operator === 'not') { text += 'NOT('; walk(node.operand); text += ')'; return; }
        text += '-('; walk(node.operand); text += ')';
        return;
      }
      case 'call': {
        const name = PROVIDER_CALLS[node.name];
        if (!name) throw new WecomError('UNSUPPORTED_FORMULA', '此函数尚未验证公式编码。', { function: node.name });
        if (!FORMULA_CALLS[node.name]) throw new WecomError('UNSUPPORTED_FORMULA', '未登记的函数。', { function: node.name });
        if (node.name === 'count_equals' && node.args[0]?.kind === 'field'
          && byId.get(node.args[0].field_id)?.type === 'TEXT') {
          throw new WecomError('UNSUPPORTED_FORMULA', '文本字段的 COUNTIF 会被服务端拒绝；请改用数值或选项字段。');
        }
        text += `${name}(`;
        node.args.forEach((arg, index) => { if (index) text += ','; walk(arg); });
        // 网页端 DATEDIF 需要第三个“单位”参数；日期差统一按天。
        if (node.name === 'date_diff_days') text += ',"D"';
        text += ')';
        return;
      }
    }
  };
  walk(expression);
  flush();
  if (!tokens.length) throw new WecomError('INVALID_ARGUMENT', '公式表达式为空。');
  return tokens;
}
