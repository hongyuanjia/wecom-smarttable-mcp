// 输出契约版本：presentRecord/查询输出、派生字段结果等对外 JSON 结构或字段语义变化时递增。
// 该版本随构建指纹发布，用于判断调用方看到的输出结构是否与当前进程一致。
export const OUTPUT_SCHEMA_VERSION = '1';

// 派生字段解析器版本：parseDerivedResult 的原始形态解码或标准化规则变化时递增。
// 与 output_schema_version 分开，避免仅调整输出字段时误报解析行为变化。
export const DERIVED_PARSER_VERSION = '1';
