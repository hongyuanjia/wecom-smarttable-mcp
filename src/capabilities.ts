import { WecomError } from './errors.js';

// 能力状态只描述“本机已验证的事实”，不把官方文档中的参数存在性当作可用性。
// verified   ：已有真实响应/写入样本或离线契约测试覆盖，可按契约使用。
// local_only ：本地模型、校验或规划可用；提供方写入/返回尚未验证。
// unavailable：缺少授权渠道或验证证据，调用必须保持线上原状。
export type CapabilityStatus = 'verified' | 'local_only' | 'unavailable';
export type SupportLevel = 'verified' | 'inferred' | 'unverified' | 'unsupported' | 'not_applicable';

export const EVIDENCE_DATE = '2026-11-02';
export const EVIDENCE_SOURCE = '本机 0.7.0 协议样本、2026-11-02 结构读取、真实视图/成员写入及离线测试';

export interface Capability {
  id: string;
  status: CapabilityStatus;
  scope: 'local' | 'provider';
  summary: string;
  prerequisites?: string[];
  limitations?: string[];
  error_code?: string;
}

const unavailable = (id: string, summary: string, prerequisites: string[], limitations?: string[], error_code = 'CAPABILITY_UNAVAILABLE'): Capability =>
  ({ id, status: 'unavailable', scope: 'provider', summary, prerequisites, ...(limitations ? { limitations } : {}), error_code });
const localOnly = (id: string, summary: string, limitations?: string[]): Capability =>
  ({ id, status: 'local_only', scope: 'local', summary, ...(limitations ? { limitations } : {}) });
const verified = (id: string, summary: string, limitations?: string[]): Capability =>
  ({ id, status: 'verified', scope: 'provider', summary, ...(limitations ? { limitations } : {}) });

export const capabilities: Capability[] = [
  verified('auth.web_session', '复用当前用户的本机网页登录态；每次执行前调用用户接口校验会话。',
    ['只代表当前账号的权限，不扩大文档访问范围；不包含机器人或企业应用授权。']),
  verified('structure.read', '读取子表目录、字段定义、视图配置摘要、记录总数与 revision。',
    ['视图的完整显示设置与未知属性仍以原始键名保留，语义未逐项验证。']),
  verified('records.read', '按整张可访问子表分页读取记录，包括图片/附件定位器。'),
  verified('records.query', '服务端条件查询。', ['仅 TEXT 的 eq/contains 与 SINGLE_SELECT 的 eq 已验证；其他类型和运算符尚未验证。']),
  verified('asset.download', '按记录定位器下载原图或附件。', ['有权限的微盘文件下载尚未验证。']),
  verified('records.write.basic', '修改普通类型单元格并回读校验。',
    ['TEXT/NUMBER/CHECKBOX/DATE_TIME/PROGRESS/PHONE/EMAIL/SINGLE_SELECT/MULTIPLE_SELECT 已验证。']),
  verified('records.add.delete', '追加和删除记录并回读校验。'),
  verified('fields.write.basic', '新增和删除普通列，并同步各视图列顺序。',
    ['新建列不等于可写入该列的值；关联、公式、查找引用列不可创建。']),
  verified('table.create', '在个人目录新建整份智能表格。'),
  verified('table.delete', '将整份智能表格移入回收站。'),

  localOnly('field.config.read', '把字段原始配置规范化为业务属性，并单独声明每种类型的支持程度。',
    ['USER 的 k7 标志位已通过实际切换多选并回读确认：k1=允许多选，k2=添加时通知。',
      'LOOKUP/FORMULA/LINK_RECORDS/TWO_WAY_LINK_RECORDS 只提取可识别的引用关系，不解释全部内部键。']),
  verified('field.config.write', '通过 HTTP 3017 重命名字段、修改人员多选/通知、数字/日期格式、选项名称与颜色、URL 显示样式、进度范围和复选框默认值，并回读核对。',
    ['已验证重命名、USER k1/k2、数字小数/千位符、日期格式/自动填充、单选/多选选项新增/改名/颜色。',
      '文本富文本、URL 显示样式、进度和复选框补丁已实现，但样本覆盖有限。',
      '标题列可重命名，但保留标题列身份。']),

  verified('member.directory.search', '通过 HTTP 通讯录接口按姓名、工号或学号检索候选成员，并通过 member_info 解析 uid/vid。',
    ['只覆盖当前企业通讯录中可检索到的成员；同名成员必须人工确认。',
      '纯数字 query 按工号/学号处理；接口不提供部门筛选，不会自动选择同名候选。']),
  localOnly('member.identity.validate', '对调用方提供的成员引用做结构、命名空间、重复与同名歧义校验。',
    ['不验证该账号是否真实存在；真实存在性必须由提供方读取或人工核对。']),
  verified('member.cell.read', '按成员身份引用读取人员单元格，保留姓名用于展示，无法解析时返回 unresolved。',
    ['网页人员单元格的实际值在 k7[].k1 中，身份命名空间为 wecom_uid。']),
  verified('member.cell.write', '通过 HTTP commitchanges 写入成员单元格（7:[{1:目标uid}], 31:操作者uid），并用 HTTP 回读核对身份集合。',
    ['必须保持字段级通知关闭；不因写入成员自动邀请、分享或发消息。',
      '单/多人约束由字段配置决定；单人字段写入多人时只保留一个成员。',
      '跨用户并发修改不被本工具原子保护。',
      '原值未读取时不得执行依赖原值的追加/移除。']),

  verified('view.read', '读取并规范化视图名称、类型、筛选、排序、分组、列顺序、列宽与个人临时筛选。',
    ['筛选连接符 1=and、2=or 与运算符 1=eq、3=contains 已用真实写入确认；其他运算符仍只保留原始代码。', '共享/个人作用域与可编辑性仅按接口来源区分。']),
  verified('view.create', '通过 HTTP commitchanges 命令 3006 新建共享表格或看板视图，包含筛选、分组、排序、列顺序和列宽。',
    ['当前验证了共享视图（k33=2）；个人视图写入范围尚未验证。', '表格/看板以外的视图类型未验证。']),
  verified('view.update', '通过 HTTP 3009 改名、3021 筛选、3020 排序、3022 分组、3018 隐藏列、3024 列宽、3016 列顺序、3033 冻结列，并回读核对；看板卡片字段通过隐藏列控制。',
    ['个人视图作用域和“锁定视图”权限级别尚未验证。', '跨用户并发修改不被本工具原子保护。']),
  verified('view.delete', '通过 HTTP 3007 删除共享视图，并按索引回读核对；至少保留一个视图。'),
  verified('view.records.read', '读取视图配置并在本机按共享筛选条件过滤记录，支持动态“我”和常用字段类型。',
    ['个人临时筛选不叠加；分组只返回定义，不重排记录。', '未识别的筛选运算符会返回 UNSUPPORTED_VIEW_FILTER。']),
  verified('view.dynamic_current_viewer', '把“我（根据查看者动态变化）”编码为人员字段的 k35=true 动态条件。',
    ['已用真实视图创建验证编码；仍需至少两个不同账号人工核对实际筛选结果。']),
  verified('kanban.create', '通过 HTTP 命令 3006 创建看板视图，配置分组字段、卡片字段和年度筛选。',
    ['看板卡片字段使用视图列顺序；未填状态记录保留行为仍需人工确认。']),

  verified('lookup.create', '通过 HTTP 3014/3017 创建查找引用字段，按“目标表字段 = 本表字段”等值匹配。',
    ['已验证原样引用、计数、去重计数；其他聚合和运算符尚未验证。',
      '只支持字段对字段的等值条件；固定值条件在网页界面中未提供，不伪造。',
      '多匹配时由提供方按原样引用/计数返回，不擅自取第一条。']),
  verified('relation.create', '通过 HTTP 3014/3017 创建单向关联字段，支持单/多选。',
    ['双向关联会同时修改另一张表，尚未验证并会明确拒绝。']),
  verified('relation.cell.write', '通过 HTTP 3013 写入单向关联单元格（18:[目标记录ID]），并按集合回读核对。',
    ['目标记录不存在或不可访问时拒绝写入，不留下悬空引用。']),

  verified('formula.create', '通过 HTTP 3014/3017 创建公式字段，把结构化 AST 编码为网页公式 token。',
    ['已验证字段引用、IF/ISBLANK/TODAY、比较与算术；其他函数会明确拒绝。',
      '配置保存与计算结果分开报告；禁止使用 JavaScript eval 执行用户公式。']),
  verified('formula.update', '通过 HTTP 3017 修改公式字段名称或表达式，并回读配置与抽样计算状态。',
    ['已支持字段引用、IF/ISBLANK/TODAY、比较与算术；其他函数会明确拒绝。']),
  unavailable('formula.calculate.verify', '核对公式计算结果与错误、空值、待计算状态。',
    ['需要提供方返回可区分的计算状态；超时只能报告 pending，不能宣告完成。']),

  localOnly('plan.local', '读取当前结构后生成本地差异、依赖顺序、影响对象和待执行动作，并持久化计划日志。',
    ['计划中的提供方写入项会按能力矩阵标记为 blocked；不提交任何线上修改。']),
  verified('verify.live', '重新读取线上结构与记录，与计划或目标配置比较。',
    ['只能核对已规范化的字段/视图/成员值；提供方未解释的原始配置标记为 unknown。']),

  verified('subtable.create', '通过 HTTP 3001 在现有文档中新建智能表子表。'),
  verified('subtable.rename', '通过 HTTP 3004 重命名子表。'),
  verified('subtable.delete', '通过 HTTP 3002 删除子表；至少保留一个子表。'),
  verified('attachment.upload', '通过 /diskagent/upload 上传附件（base64 表单）或 /diskthumb/doc_img_upload 上传图片（multipart），再写入图片/附件单元格并回读核对。',
    ['单文件限制 50 MiB；附件使用 SS_File 文件标识，图片使用 CDN URL 与宽高。',
      '不自动修改文件名或压缩图片；图片尺寸由上传响应返回。']),
  verified('url.cell.write', '通过 3013 写入 URL 单元格（8:[{1:url,2:显示文本}]），并回读核对。'),
  unavailable('system_field.write', '写入创建人、最后编辑人等系统字段。', ['系统字段由服务端维护，不提供写入。']),
];

export interface FieldSupport {
  recognize: SupportLevel;
  read_config: SupportLevel;
  write_config: SupportLevel;
  write_cell: SupportLevel;
  read_computed: SupportLevel;
}

const normal: FieldSupport = { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' };
const createOnly: FieldSupport = { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'unsupported', read_computed: 'not_applicable' };

// 逐类型声明“识别 / 读配置 / 写配置 / 写单元格 / 读计算值”，避免把类型存在当成可写。
export const fieldTypeSupport: Record<string, FieldSupport> = {
  TEXT: normal,
  NUMBER: normal,
  CHECKBOX: normal,
  DATE_TIME: normal,
  PROGRESS: normal,
  PHONE: normal,
  EMAIL: normal,
  SINGLE_SELECT: normal,
  MULTIPLE_SELECT: normal,
  IMAGE: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' },
  ATTACHMENT: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' },
  URL: { recognize: 'verified', read_config: 'inferred', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' },
  USER: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' },
  CREATED_USER: { recognize: 'verified', read_config: 'not_applicable', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'verified' },
  MODIFIED_USER: { recognize: 'verified', read_config: 'not_applicable', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'unverified' },
  CREATED_TIME: { recognize: 'verified', read_config: 'verified', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'unverified' },
  MODIFIED_TIME: { recognize: 'verified', read_config: 'verified', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'unverified' },
  LINK_RECORDS: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'verified', read_computed: 'not_applicable' },
  FORMULA: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'unsupported', read_computed: 'inferred' },
  LOOKUP: { recognize: 'verified', read_config: 'verified', write_config: 'verified', write_cell: 'unsupported', read_computed: 'inferred' },
  TWO_WAY_LINK_RECORDS: { recognize: 'verified', read_config: 'unverified', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'not_applicable' },
};

export function fieldSupport(type: string): FieldSupport {
  return fieldTypeSupport[type] || { recognize: 'unsupported', read_config: 'unsupported', write_config: 'unsupported', write_cell: 'unsupported', read_computed: 'unsupported' };
}

export function capabilityById(id: string): Capability {
  const found = capabilities.find(capability => capability.id === id);
  if (!found) throw new WecomError('INTERNAL_ERROR', `未登记的能力：${id}`);
  return found;
}

export function capabilityError(id: string, extra: Record<string, unknown> = {}) {
  const capability = capabilityById(id);
  return new WecomError(capability.error_code || 'CAPABILITY_UNAVAILABLE',
    `${capability.summary} 当前不可用：本机没有经过验证的提供方操作渠道或回读证据，线上内容保持不变。`, {
      capability: id,
      status: capability.status,
      prerequisites: capability.prerequisites || [],
      limitations: capability.limitations || [],
      evidence_date: EVIDENCE_DATE,
      evidence_source: EVIDENCE_SOURCE,
      ...extra,
    });
}

export function requireCapability(id: string, extra: Record<string, unknown> = {}): void {
  const capability = capabilityById(id);
  if (capability.status !== 'verified') throw capabilityError(id, extra);
}

export function capabilityMatrix() {
  return capabilities.map(capability => ({ ...capability }));
}

export function supportSummary() {
  return Object.entries(fieldTypeSupport).map(([type, support]) => ({ type, ...support }));
}
