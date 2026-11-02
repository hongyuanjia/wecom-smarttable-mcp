// 输出契约版本：presentRecord/查询输出、派生字段结果等对外 JSON 结构或字段语义变化时递增。
// 该版本随构建指纹发布，用于判断调用方看到的输出结构是否与当前进程一致。
export const OUTPUT_SCHEMA_VERSION = '4';

// 派生字段解析器版本：parseDerivedResult 的原始形态解码或标准化规则变化时递增。
// 与 output_schema_version 分开，避免仅调整输出字段时误报解析行为变化。
export const DERIVED_PARSER_VERSION = '3';

// 构建指纹覆盖的模块清单只在这里维护；构建脚本和运行时都从编译后的同一份元数据读取。
export const BUILD_MODULES = Object.freeze({
  entry: 'server.js',
  protocol: 'protocol.js',
  views: 'views.js',
  'view-semantics': 'view-semantics.js',
  writer: 'writer.js',
  planner: 'planner.js',
} as const);

export type BuildModuleName = keyof typeof BUILD_MODULES;

export function contractVersions() {
  return { output_schema_version: OUTPUT_SCHEMA_VERSION, derived_parser_version: DERIVED_PARSER_VERSION };
}
