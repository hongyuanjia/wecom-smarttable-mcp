# 企业微信智能表格 MCP

本机 stdio MCP，复用个人网页登录态操作企业微信智能表格。支持读取表结构与记录、下载原图与附件、新建智能表格、增删改记录、增删普通列，以及将整份智能表格移入回收站。0.9.0 起增加能力矩阵、成员通讯录检索、成员单元格 HTTP 写入、视图规范化读取与共享/个人/锁定视图写入、视图级配置摘要校验，以及字段属性、查找引用（条件/固定值/沿关联字段、8 种统计方式与歧义诊断）、单向/双向关联、关联单元格、公式（展示格式、已验证函数、计算结果读取）、视图列设置/字段统计标志、子表新建/重命名/删除、URL 单元格、附件/图片上传、扩展条件查询（URL/电话/邮箱/复选框/多选/关联标题文本）和本机执行日志。登录在专用 Chrome 窗口中手动完成，无需配置机器人、企业应用 Secret、管理员授权、数据库或额外模型服务。

## 日常使用与登录

接入客户端后，直接发送智能表格链接即可，例如：“用 MCP 看一下这个智能表格链接：……”。工具按当次传入的 URL 操作，并复用本机已保存的登录态。

会话有效时直接执行；未登录或会话过期时，先通过 MCP 表单弹出确认，确认后拉起专用 Chrome 窗口。手动扫码或登录后，登录助手会验证账号状态、保存会话并关闭浏览器窗口，随后自动恢复原请求一次。写入操作仅在请求尚未发出时才会进入登录恢复流程；请求发出后若遇到错误或回读校验失败，不会自动重试。文档读写权限由具体操作检查，权限不足或解析失败不会触发重新登录。取消表单、关闭浏览器窗口或中止请求会直接结束本次操作。

登录助手最长等待 15 分钟。建议按示例配置设置 `tool_timeout_sec = 1200`，避免客户端默认超时（如 180 秒）在扫码完成前中断请求。若客户端不支持 MCP 表单，工具会返回 `LOGIN_REQUIRED` 或 `AUTH_EXPIRED` 错误并附上本机登录助手路径，不会静默拉起浏览器。

会话有效期由企业微信服务端决定，本地 Cookie 过期时间不代表服务端会话仍然有效；每次执行前都会先调用用户接口校验会话。

## 首次准备与手动登录

环境要求：Node.js 22+、Google Chrome，以及可访问目标智能表格的企业微信账号（目前已在 macOS 完成验证）。登录助手使用独立 profile，不影响日常使用的 Chrome 资料。

登录复用系统已安装的 Google Chrome，无需额外执行 `playwright install`。

### npm 安装

直接由 MCP 客户端通过以下命令启动，无需克隆仓库或安装 TypeScript：

```sh
npx -y wecom-smarttable-mcp@latest
```

这是 stdio 服务，直接在终端执行后会等待 MCP 请求；正常使用时由客户端启动。首次运行需联网下载 npm 包及运行依赖，后续复用 npm 缓存。也可以全局安装：

```sh
npm install -g wecom-smarttable-mcp@latest
wecom-smarttable-mcp
```

如需手动登录，全局安装后运行 `wecom-smarttable-login '智能表格链接'`；未全局安装时运行：

```sh
npx -y --package=wecom-smarttable-mcp@latest wecom-smarttable-login '智能表格链接'
```

### 从源码运行

需要开发调试时，克隆仓库、安装依赖并构建：

```sh
git clone https://github.com/hyofeng/wecom-smarttable-mcp.git
cd wecom-smarttable-mcp
npm ci
npm run build
```

接入后直接向客户端提供链接即可，首次登录同样由 MCP 自动引导。如果需要在终端手动排查，或者客户端不支持表单交互，可执行：

```sh
node /absolute/path/to/wecom-smarttable-mcp/dist/login.js '智能表格链接'
```

命令中的链接仅用作登录后的跳转入口，不会限制后续可访问的表格范围；也可不传链接直接运行 `node /absolute/path/to/wecom-smarttable-mcp/dist/login.js`（默认打开企业微信文档首页，新建智能表格时同样使用该入口）。请勿在对话或配置中粘贴 Cookie、Token 或 cURL。

MCP 启动命令（由客户端通过 stdin/stdout 拉起）：

```sh
node /absolute/path/to/wecom-smarttable-mcp/dist/server.js
```

## Codex 接入

将 [examples/codex-mcp-npm.toml](examples/codex-mcp-npm.toml) 中的配置段加入 `~/.codex/config.toml`，并开启新的 Codex 会话：

```toml
[mcp_servers.wecom_smarttable]
command = "npx"
args = ["-y", "wecom-smarttable-mcp@latest"]
startup_timeout_sec = 120
tool_timeout_sec = 1200
```

首次下载预留 120 秒启动时间。若客户端找不到 `npx`，将 `command` 改为终端中 `command -v npx` 输出的绝对路径，并确保客户端进程的 `PATH` 中包含 Node.js 22+。示例使用 `@latest`；发布新版本后重连 MCP 即可按当前 latest 版本启动，无需逐次修改配置。

从源码运行时，使用 [examples/codex-mcp.toml](examples/codex-mcp.toml)。把其中的 `/absolute/path/to/` 替换为本机实际绝对路径：`command` 填 `node -p "process.execPath"` 输出的 Node 路径，`args` 和 `cwd` 填仓库路径。后续若升级或迁移 Node，需同步更新配置中的 `command`；修改代码后，重新执行 `npm run build` 并重连 MCP（或重开会话）即可生效。两份示例使用相同的服务名，选择一种配置即可。配置格式参考 [OpenAI MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

提供的工具列表：

| 工具 | 用途 |
| --- | --- |
| `wecom_table_structure` | 获取全部或指定子表的字段定义（ID/名称/类型/标题列标记）、视图与筛选配置、记录总数及版本号（`revision`） |
| `wecom_query_records` | 按字段条件在服务端筛选，分页返回匹配记录；文本/URL/电话/邮箱支持 eq/ne/contains/not_contains，单选支持 eq/ne，多选支持 eq/ne/contains/not_contains，另支持复选框、人员、数字/进度/日期及按关联记录标题筛选关联/双向关联，支持 AND/OR 组合 |
| `wecom_read_records` | 按子表分页读取记录，可指定字段 ID，返回字段值及图片/附件 `locator` |
| `wecom_download_asset` | 校验 `locator` 所属记录与字段后下载单个原图或附件；小图片可选同时返回 MCP 图像 |
| `wecom_upload_asset` | 上传本机文件到图片/附件字段并写入记录，回读文件名、大小、MD5/URL |
| `wecom_create_table` | 在个人目录新建智能表格，回读并返回链接、默认表结构与初始记录数 |
| `wecom_update_records` | 按 `record_id` 修改指定字段，并校验提交确认与回读结果 |
| `wecom_add_records` | 在子表末尾追加记录，回读校验并返回新生成的 `record_id` |
| `wecom_delete_records` | 按 `record_id` 删除指定记录及其内容，整表回读校验删除结果 |
| `wecom_add_fields` | 在子表末尾新增普通列，支持设置单选/多选选项 |
| `wecom_delete_fields` | 删除指定普通列及列内数据，保留标题列，并校验字段列表与各视图列顺序 |
| `wecom_delete_table` | 将指定 `url` 或 `document_id` 的整份智能表格移入回收站；支持 `check_only` 只读查询状态 |
| `wecom_create_sheet` / `wecom_rename_sheet` / `wecom_delete_sheet` | 在现有文档中新建、重命名或删除子表，并回读核对 |
| `wecom_capabilities` | 查看每项能力的 `verified`/`local_only`/`unavailable` 状态、前提和逐字段类型支持度；`probe=true` 时只读探测当前文档 |
| `wecom_search_members` | 通过企业微信通讯录 HTTP 接口按姓名、工号或学号检索，返回 `uid/vid`、姓名、企业和职位；同名候选全部返回，不自动选择 |
| `wecom_validate_members` | 本地校验成员引用、命名空间、重复项和同名歧义；可对授权候选列表做姓名匹配 |
| `wecom_read_view` | 读取单个视图的筛选、排序、分组、列顺序、可见列、隐藏列、列宽、冻结列、作用域/可编辑性、配置摘要与未知设置 |
| `wecom_read_view_records` | 按视图共享筛选在本机过滤记录，支持动态“我”、分页和字段选择 |
| `wecom_update_member_cells` | 通过 HTTP `commitchanges` 写入成员，支持单/多选、替换/追加/移除/明确清空，并按 uid 集合 HTTP 回读核对 |
| `wecom_create_view` / `wecom_update_view` / `wecom_delete_view` | 通过 HTTP 创建共享/锁定/个人视图，或更新名称、作用域、筛选、分组、排序、隐藏列、列宽、列顺序、冻结列、字段统计标志（`statistics`，3025 写入 `k1.k10`）、看板卡片；创建同名视图时按规范化配置比较：相同返回已有视图且 `no_changes=true`，不同返回 `VIEW_CONFIG_DIFF` 并要求用 `view_id` 更新，多个同名返回 `VIEW_AMBIGUOUS`。支持 `config_digest` 并发校验和删除视图 |
| `wecom_update_fields` | 通过 HTTP `3017` 重命名字段、修改人员多选/添加通知，并回读核对 |
| `wecom_create_lookup_field` | 通过 HTTP 创建查找引用字段，支持条件匹配/固定值/沿关联字段、8 种统计方式和零匹配/多匹配诊断 |
| `wecom_create_relation_field` / `wecom_update_relation_cells` | 通过 HTTP 创建单向关联字段，并按目标记录 ID 写入关联单元格、集合回读 |
| `wecom_create_formula_field` / `wecom_update_formula_field` | 把受限 AST 编码为网页公式 token；写入前执行与计划工具相同的函数、参数数量、类型、依赖冲突和循环校验；读取 k36 结果与错误/空/待计算状态，不使用 `eval` |
| `wecom_list_executions` | 读取本机执行日志：execution_id、时间、文档/子表、操作、版本、可选 plan_id 和 verified/not_verified；可按 document_id 与 plan_id 过滤，每个文档默认保留最近 1000 条 |
| `wecom_plan_changes` | 只读生成配置差异、依赖顺序、影响对象和 blocked 原因，并保存本机计划记录 |
| `wecom_verify_changes` | 重新读取线上结构与人员单元格，与保存计划或内联 changes 比较，逐项返回 verified/pending/conflict/unknown |

常用指令示例：

- “先看下这个智能表格有哪些子表、字段和视图：`<链接>`”
- “读取第一个子表前 20 条记录的问题描述、图片和附件。”
- “翻到下一页，把这条记录里的报错原图下载下来看下。”
- “找到这条记录的附件列表，下载里面的 PPTX 文件。”
- “在个人目录新建一张项目排期表，把链接发我。”
- “在这张表里新增『状态』和『工时』两列，再追加两条任务记录。”
- “把这两条记录的状态改成已完成，删掉最后两条测试记录。”
- “把这个链接对应的智能表格移到回收站：`<链接>`”

基本调用顺序：操作已有表格时，先调 `wecom_table_structure` 获取字段 ID，已知子表 ID（链接中的 `tab`）时可传 `sheet_id` 只读取该子表结构，省略则获取全部子表。然后用 `wecom_read_records` 整表分页，或用 `wecom_query_records` 按条件检索；翻页时原样传回上一页的 `next_cursor`。

全量结构最多同时读取 4 张子表，返回顺序仍与子表目录一致。读取记录时，`columns` 和记录中的字段按传入的 `fields` 顺序返回；后续页省略 `fields` 会沿用游标中的顺序。

下载图片或附件时，传入记录中的完整 `locator` 与同一表格链接。整表读取返回的定位器包含真实来源分页范围；查询返回的定位器标记 `source: "record_query"`，下载时直接按记录 ID 回读核实归属，无需再遍历整表。两种定位器都不是界面行号，跨会话可重新校验；若原分页范围已不含该记录，可重新读取或查询记录获取定位器。

## 按条件检索记录

先调用 `wecom_table_structure` 获取真实子表、字段及选项 ID，再调用 `wecom_query_records`。筛选在企业微信服务端执行，只分页返回匹配记录，不扫描整张子表；每次查询前后各读取首条分块以取得结构和核对版本。

```json
{
  "url": "<智能表格链接>",
  "sheet_id": "<子表 ID>",
  "filter": {
    "conjunction": "and",
    "conditions": [
      { "field_id": "<状态字段 ID>", "operator": "eq", "value": "<状态选项 ID>" },
      { "field_id": "<问题描述字段 ID>", "operator": "contains", "value": "登录" }
    ]
  },
  "page_size": 50
}
```

- 支持 TEXT/URL/电话/邮箱与关联标题文本的 eq/ne/contains/not_contains、单选 eq/ne、多选 eq/ne/contains/not_contains、复选框 eq/ne、人员 eq/ne、数字/进度比较、日期比较，以及各类型的 empty/not_empty；单选不支持 contains/not_contains。最多 20 个条件，通过 `and`/`or` 连接。
- 值形状固定为：URL `valueUrl`、电话 `valuePhoneNumber`、邮箱 `valueEmail` 均为字符串；复选框 `valueCheckbox` 为布尔值；多选 `valueSelects` 为选项 ID 数组；进度 `valueProgress` 为数字（不是对象）。
- 单向/双向关联没有按记录 ID 过滤：值条件按**被关联记录的标题文本**匹配（内部编码 `filterKeyType=1` + `valueText`），支持 eq/ne/contains/not_contains 和 empty/not_empty；不要传记录 ID 数组。
- 错误的值键名会被服务端静默忽略并退化为全表，因此工具在本地严格校验值键和 JSON 类型，不把这些情况当作“无匹配”。复选框值比较的 empty/not_empty 在 API 层可用，但网页筛选面板只提供 eq/ne。
- 含换行查询值的文本 `eq` 在真实接口中出现与读取值不一致的结果，当前拒绝此用法；可使用单行关键词 `contains`。
- 返回 `total_matching_records`、`records`、`has_more`、`next_cursor`。每页默认 50 条，最多 200 条；翻页时继续传入同一条件并原样传回游标，`fields` 可省略以沿用上一页，显式传入时必须保持一致。版本变化返回 `STALE_CURSOR`，需从第一页重查；损坏或不匹配的游标返回 `INVALID_CURSOR`。
- 查询不叠加 URL `viewId`、个人或保存的视图筛选。接口异常会明确失败，不自动改成全表扫描。
- 字段值沿用读取工具的格式，`fields` 在本机选择输出字段。默认只返回正文、状态、选项、链接与文件定位等信息，省略原始富文本 `fragments`；确需片段时传 `include_text_fragments: true`，后续页会自动沿用该设置。图片/附件的完整 `locator` 可直接交给 `wecom_download_asset`。
- 条件查询从 npm `0.5.0` 起提供；按子表获取结构、查询结果直接下载、翻页沿用字段及默认省略原始片段从 `0.6.0` 起提供。升级后请重新从第一页开始读取，不复用旧版游标。

## 写入范围与核对

修改已有表格的行列时，必须传入 `expected_revision`（取自最近一次结构/记录读取或上一次写入返回的 `revision`）。若返回 `STALE_REVISION`，说明服务端版本已变化且本次请求尚未提交，需重新读取最新内容后再决定是否修改，切勿仅替换版本号直接覆盖。所有写入均按明确传入的 `sheet_id`、`record_id`、`field_id` 定位，不按界面行号或名称猜测。

- **批量限制**：单次可新增/更新/删除 1–100 条记录，或新增/删除 1–20 列；编码后单次请求体上限为 1 MiB，超限会在提交前直接拒绝。
- **支持写入的单元格类型**：`TEXT`、`NUMBER`、`CHECKBOX`、`DATE_TIME`、`PROGRESS`、`PHONE`、`EMAIL`、`SINGLE_SELECT`、`MULTIPLE_SELECT`。文本/电话/邮箱传字符串，日期传毫秒时间戳，进度支持默认的 `0–1` 数值，单选/多选传结构中已有的选项 ID 数组（不支持按名称匹配或自动新建选项）。人员单元格使用 `wecom_update_member_cells`，单向关联单元格使用 `wecom_update_relation_cells`。
- **清空单元格**：传入 `null` 清空。企业微信服务端在清空后可能直接省略该单元格字段；工具仅在同时拿到本次明确清空确认及对应版本的记录回读时才判定清空成功，普通读取中出现的 `not_returned` 仍只代表服务端未返回该格，不等同于空值。
- **新增与删除列**：`wecom_add_fields` 支持 `TEXT` 等普通列及 `IMAGE`、`ATTACHMENT`、`USER`、`URL` 列；单选/多选列可通过 `options` 传入选项名称数组并返回生成的选项 ID。查找引用、单向/双向关联和公式字段使用各自的专用工具创建；复杂列删除仍未验证。
- **标题列与视图顺序**：标题列带 `is_primary` 标记，不可删除。增删普通列后会同步调整并核对各视图中的字段顺序，避免字段定义已删但视图仍残留旧列 ID。
- **新建表与追加行**：新建表格自带的默认子表、列和初始空记录由企业微信服务端生成，工具按实际回读结果原样返回，不会自动隐藏或清空。追加记录目前仅支持企业微信默认的 11 位 base36 行序格式，遇到其他排序格式会直接报错。

同一 MCP 进程内，针对同一文档的写请求会串行排队：提交前再次核对版本，提交后核对本次请求的确认标识、版本号与回读数据。由于企业微信服务端会合并旧版本命令，`base_rev` 本身不具备跨端原子锁效果，其他客户端仍可能在提交窗口内并发修改；本工具不提供跨客户端原子冲突保护或批量事务回滚。若提交期间或提交后发现版本偏移、数据不符，会返回未完成核验错误。

当返回 `WRITE_RESULT_UNKNOWN` 或 `WRITE_NOT_VERIFIED` 时，说明请求可能已在服务端生效（错误详情中会附带相关的记录/字段/文档 ID）。此时应先重新读取或打开表格核实状态，切勿直接重放新增或删除请求。写请求一旦发出，不会因后续认证过期、网络波动或回读失败而自动重试。新建表格若在回读阶段失败，也会尽量返回已创建的文档链接，避免重复创建。

## 能力矩阵与配置计划（0.9.0）

0.9.0 把“类型存在”和“当前可用”分开声明。先调用 `wecom_capabilities` 查看能力矩阵，不要仅凭官方文档中的参数推断当前账号或后端支持某项配置。

- `verified`：已有真实响应/写入样本或离线契约测试，可按契约使用。
- `local_only`：本地模型、校验或规划可用；提供方读取语义或写入尚未验证。
- `unavailable`：缺少授权渠道或验证证据，调用必须保持线上原状。

当前 `verified` 的提供方操作是读取、查询（含 URL/电话/邮箱/复选框/多选值与关联标题文本）、下载、普通单元格/记录/普通列写入、附件/图片上传、新建表、回收站删除、成员通讯录检索、成员单元格 HTTP 写入（字段通知关闭时）、共享/个人/锁定视图的创建/改名/筛选/分组/排序/隐藏列/列宽/列顺序/冻结列/字段统计标志/删除（含动态“我”）、按视图读取记录，以及字段属性、查找引用（固定值与 8 种统计方式）、单向/双向关联、关联单元格、公式（含展示格式）、子表操作和 URL 单元格写入。以下能力仍为 `unavailable` 或只支持已验证子集，对应工具会明确拒绝，不会静默降级：

- 文本字段上的 `COUNTIF`（服务端返回 errorType 4，创建前拒绝）；
- `COALESCE`、`PERCENT`（服务端返回 errorType 8「不识别的内容」，创建前拒绝）；
- 关联/双向关联按目标记录 ID 过滤（只支持按被关联记录标题文本筛选和 empty/not_empty）；
- 逐列统计（3019）的持久化读写（本轮只实现 3025 的字段统计标志）；
- 查找引用条件中除 `eq`、`contains` 外的运算符；
- 复杂列删除；
- 个人视图的跨账号可见性差异（需要至少两个授权账号人工核对）。

### 成员身份与写入

`wecom_search_members` 通过企业微信通讯录 HTTP 接口检索，`query` 可以是姓名、工号或学号（纯数字按工号/学号处理），返回 `namespace: "wecom_uid"`、`id`（uid）、`vid`、姓名、企业和职位。同名候选会全部返回并标记 `ambiguous`，不会自动选择；`wecom_validate_members` 仍可在本机做结构、重复和命名空间校验。

`wecom_update_member_cells` 通过 **HTTP `commitchanges`** 写入，字段必须已关闭“添加人员时通知”，支持单人/多人字段、替换/追加/移除和 `members: []` 明确清空；写入后按 uid 集合做 HTTP 回读核对。成员单元格的真实编码为 `7: [{1: 目标uid}]`、`31: 操作者uid`；只写目标 uid 会被服务端丢弃。成员字段的原始标志已通过开关实验确认：`k1` 为允许多选，`k2` 为添加时通知。不会因写入成员自动邀请、分享或发消息。

### 视图与显示

`wecom_read_view` 会返回列顺序、隐藏列、列宽、分组、排序、筛选条件、个人临时筛选、共享/锁定/个人作用域、可编辑性、`config_digest` 和未识别设置键名。个人视图仅 owner 可编辑，锁定视图不可编辑。更新视图时可传 `expected_view_digest`（即 `config_digest`）做视图级并发校验。筛选连接符（`1=and`、`2=or`）与运算符（`1=eq`、`3=contains`）已用真实写入验证，其他运算符只保留原始代码。补丁语义固定为：省略属性=保持原值，`filter: null`=显式清除筛选，空 `conditions` 不会被当作清空。新建视图时 `field_order` 可只列可见字段并按该顺序保存；`hidden_fields` 指定要隐藏的字段；列宽可通过 `widths` 设置。

`wecom_create_view` 通过 HTTP `3006` 新建共享/锁定/个人视图；`wecom_update_view` 通过 `3009`（改名/作用域）、`3021`（筛选）、`3020`（排序）、`3022`（分组）、`3018`（隐藏列）、`3024`（列宽）、`3016`（列顺序）、`3033`（冻结列）、`3025`（字段统计标志）局部修改并回读；多步更新中途失败返回 `PARTIAL_APPLY`。`statistics` 写入 `{1:sheetId, 2:viewId, 3:{1:boolean}}` 并回读 `k1.k10`，省略表示保持原值，`null` 归一化为关闭。`k10` 是字段统计启用标志，**不是底部统计行显隐**：底部行始终存在，逐列统计由 `3019` 控制；当前 PC build 没有用户可见的 `k10` 开关，3025 属于内部命令路径。`wecom_delete_view` 通过 `3007` 删除。看板卡片字段通过隐藏非卡片列控制。`wecom_read_view_records` 读取共享筛选并在本机过滤记录。

`current_viewer`（动态“我”）编码为人员字段筛选的 `k35=true`，可用 `wecom_create_view` / `wecom_update_view` 写入；实际筛选结果仍需至少两个授权账号人工核对，不得用执行者固定账号替代。

### 字段属性、查找引用、关联与公式

`wecom_update_fields` 通过 HTTP `3017` 重命名字段，或修改人员字段的多选/添加通知标志（`k7.k1` / `k7.k2`），并回读核对。标题列可重命名，但保留标题列身份。

`wecom_create_lookup_field` 通过 `3014` + `3017` 创建查找引用字段。支持条件匹配（字段对字段、文本/单选固定值）和沿关联字段引用（`k1=关联字段,k4=0`），以及原样引用、去重引用、求和、计数、去重计数、平均值、最大值、最小值八种统计方式（`k3=0…7`）；求和/平均/最大/最小只允许数字或进度目标字段。创建后返回零匹配、多匹配和关联空值诊断；`fail_on_ambiguous=true` 时匹配键多匹配返回 `LOOKUP_AMBIGUOUS`。目标字段不存在、条件字段不属于声明作用域时不会提交。

`wecom_create_relation_field` 创建单向关联（类型 18）或双向关联（类型 21）。双向关联只提交正向字段，`backFieldId` 预生成，服务端在同一提交内自动创建反向字段；跨表提交会返回两条 `respective`，工具按最大 `newRev` 回读。`wecom_update_relation_cells` 按目标记录 ID 写入关联单元格：单向编码 `18:[目标记录ID]`；双向编码 `21:{1:[新增],2:[删除]}`，且 `3013` 的 `c.6=true` 才会触发服务端反向同步，工具会同时回读两侧。目标记录不存在时拒绝，不留下悬空引用。

`wecom_create_formula_field` / `wecom_update_formula_field` 把受限 AST 编码为网页公式 token：文本片段 `{1:1, 2:text}` 与字段引用 `{1:2, 3:field_id}`。直接创建/更新与计划工具共用校验：未登记函数、参数数量、类型、声明依赖冲突、自引用和依赖循环都在提交前拒绝，返回 `FORMULA_INVALID`、`FORMULA_TYPE_MISMATCH`、`FIELD_DEPENDENCY_CONFLICT` 或 `UNSUPPORTED_FORMULA`，不发出 HTTP 写入。已验证字段引用、`IF`、`ISBLANK`、`TODAY`、`COUNT`、`COUNTA`、`COUNTIF`（数值范围）、`DATEDIF`（按天）、`CONCATENATE`、`ROUND`、比较和算术；展示格式支持 `text/number/percent/currency/date/checkbox/email/progress`。写入后读取 `k36`，区分 computed/empty/pending/error，有限次数等待并返回样本结果、返回类型和错误；文本字段的 `COUNTIF`、`COALESCE` 和 `PERCENT` 会明确拒绝。

### 计划与核对

`wecom_plan_changes` 只读取当前结构与人员单元格，生成本地差异、依赖顺序、影响对象和能力前提，不提交任何修改。相同结构与变更会得到稳定的 `plan_id`，重复执行同一配置应得到空差异。计划默认保存在本机数据目录的 `plans/<plan_id>.json`（权限 `600`，不包含 Cookie/Token）。

```json
{
  "url": "<智能表格链接>",
  "sheet_ids": ["<子表 ID>"],
  "changes": [
    {
      "kind": "view",
      "action": "update",
      "sheet_id": "<子表 ID>",
      "view_id": "<视图 ID>",
      "patch": { "name": "全部记录", "filter": null, "group": [], "sort": [{ "field_id": "<字段 ID>" }] }
    }
  ]
}
```

`wecom_verify_changes` 可传 `plan_id` 或内联 `changes`，重新读取线上结构与人员单元格后逐项返回：

- `verified`：已规范化的配置或成员身份与目标一致；
- `pending`：仍有差异或尚未创建；
- `conflict`：同名但无法确认一致，或存在冲突；
- `unknown`：原始配置中出现未解释的设置键，或无法判定同名配置是否一致时使用，不能当作成功。

成员单元格的 `not_returned` 不等同于空值；清空操作在只有 `not_returned` 时会报告待核对，而不是 verified。

### 执行日志

写入工具共用可选 `plan_id`（64 位十六进制计划 ID）。写入成功后 `execution_id`、时间、文档/子表、操作、版本、状态和 `plan_id` 会保存到本机 `executions/`，文件权限 `600`；`wecom_list_executions` 可按 `document_id` 和 `plan_id` 过滤。每个文档默认保留最近 1000 条，保存新日志后清理最旧条目；可用 `WECOM_MCP_EXECUTION_RETENTION` 调整上限。日志不含 Cookie、Token、签名链接或文件内容。

## 删除整份智能表格

`wecom_delete_table` 仅在用户明确要求删除某份智能表格时调用（`wecom_create_table` 创建新表后不会自动清理生成结果）。定位参数为 `url` 或 `document_id`（两者同时传入时必须指向同一文档），不支持按标题搜索、批量删除或永久删除。

执行删除时，工具先校验目标是否为智能表格、文档到文件 ID 的唯一映射关系以及当前账号的删除权限，再提交一次移入回收站任务；待异步任务完成并在回收站中核实对应的文件 ID、智能表格类型和删除状态后，才返回 `state: "recycle_bin"`、`recycle_verified: true`、`permanent: false`。若目标文档已在回收站中，则直接返回确认状态，不会重复提交。回收站保留时长由企业微信服务端决定。

传入 `check_only: true` 可只读查询当前文档状态（不提交删除任务），适合在删除结果不确定时复核。注意：`check_only` 返回 `state: "active"` 仅代表当前时刻文档仍可访问，不能排除先前的异步删除任务仍在处理中，请勿据此盲目重复提交删除。

## 读取范围与附件下载

- **文档类型**：支持 `/smartsheet/` 智能表格；传入 `/sheet/` 普通在线表格会返回 `UNSUPPORTED_TYPE`。
- **读取范围**：`wecom_read_records` 始终按当前用户在整张子表中的可访问范围分页，**忽略 URL 中的 `viewId` 及任何视图筛选条件**（视图的筛选配置可在 `wecom_table_structure` 返回值中查看）。条件查询请使用 `wecom_query_records`，仅应用显式传入的条件。
- **分页与游标**：每页 1–200 条（默认 50），返回总记录数、当前页范围、返回条数、`has_more` 及 `next_cursor`。翻页中途若子表版本变化会返回 `STALE_CURSOR`，需从第一页重读以免遗漏或重复。分页范围不等于界面行号，记录顺序也不保证与界面视图排序一致。
- **输出大小限制**：单次工具 JSON 响应上限为 1 MiB。默认省略原始富文本片段，确需时设置 `include_text_fragments: true`；仍超限时可调小 `page_size` 或通过 `fields` 仅选择所需字段（字段过滤在本机完成，底层分块接口仍按页拉取整行数据）。
- **缺失值与派生值**：`not_returned` 表示服务端未下发该单元格（不等同于空值）；`unresolved` 表示未解析出标准字段值。LOOKUP/FORMULA 会解析 `k36`，返回 `present`/`empty`/`pending`/`error`、`result_type`、`members`/`options`、`computed_result`、样本值和错误；空结果与未返回严格区分。
- **图片与附件**：仅识别字段类型为 `IMAGE` / `ATTACHMENT` 的文件，正文中的普通 URL 保持为文本，不会当作附件下载。开启 `inline_image: true` 时，4 MiB 以内且格式支持的图片会同时返回 MCP image 载荷，所有下载文件均保存在本机并返回本地路径。
- **附件类型支持**：直接上传的 `SS_File` 附件支持下载原始文件；微盘（`Wedrive`）附件目前仅支持识别无权限状态（`ATTACHMENT_ACCESS_DENIED`），有权限的微盘文件下载暂未支持，遇到未适配的响应页面会直接报错，不会把预览网页当成附件保存。
- **流式写盘与校验**：单文件下载上限为 100 MiB，附件与 CDN 图片均采用流式写盘并实时限制字节数，超限、取消或出错时立即中止并清理未完成文件。下载结果返回实际 MIME、字节数、SHA-256、原始文件名及本地保存路径；图片还会在前 512 KiB 文件头内解析并校验宽高尺寸。

## 本机数据与安全

默认数据目录为仓库外的 `~/.local/share/wecom-smarttable-mcp/`，可通过环境变量 `WECOM_MCP_DATA_DIR` 指定其他专用绝对路径：

- `profile/`：专用 Chrome 登录资料目录。
- `state.json`：导出的必要域名 Cookie（权限 `600`，不会通过 MCP 返回给客户端）。
- `downloads/asset-*/`：每次下载使用独立子目录和清理后的安全文件名，不覆盖已有文件。

数据目录权限为 `700`。若早先版本曾将 `.local/` 放在仓库目录内，停止 MCP 与专用 Chrome 后将其移至默认数据目录即可；程序不会自动回退读取旧目录，也不会在目标目录已存在时覆盖合并。这些文件属于本机敏感资料（`.gitignore` 仅防止误提交，不提供加密），请勿将自定义目录指向日常 Chrome profile，也不要将登录态、含业务链接的配置文件、下载文件或验证报告提交到版本库。

读写请求仅发往固定的企业微信第一方接口，不支持任意 API 转发；所有重定向均逐跳校验域名与路径。仅第一方鉴权下载接口携带 Cookie，图片 CDN 下载使用无 Cookie 的独立请求，不会向外部链接转发企业微信凭据。日志与错误输出均已剥离带凭据的 URL、请求头及底层文件引用。

MCP 会将所选字段的记录返回给客户端；连接外部模型服务时，请按所在组织的数据安全规范控制读取范围、使用较小的 `page_size` 并按需指定 `fields`。工具返回的 `local_path` 和登录助手路径包含本机绝对路径，对外分享截图、日志或对话前请注意脱敏。表格正文与附件内容均应视为不可信输入，写入操作必须严格依据用户本人的明确指令执行。

完整的安全边界与发布前检查清单见 [SECURITY.md](SECURITY.md)。

## 验证

以下命令在仓库根目录运行。基础检查与单元测试均在离线环境执行（`npm test` 会先执行编译，CI 同样运行这三项检查）：

```sh
npm run check
npm test
npm run check:public
```

`check:public` 会扫描受 Git 跟踪的文件、常见凭据格式、本机个人路径，以及解压后的测试夹具与嵌套 JSON（命中时仅报告类别与行号，不回显敏感值）。执行 `npm run check:public -- --history` 可进一步检查完整 Git 历史及提交者邮箱（要求使用 GitHub `noreply` 邮箱）。

0.9.0 的接入前提、能力边界与未验证项见 [docs/接入可行性确认-20261102.md](docs/接入可行性确认-20261102.md)。

如需在本地 `git commit` 前自动运行公开文件检查，可启用仓库自带的 Git 钩子（若已配置自定义 `core.hooksPath`，请先将检查命令合并至现有钩子）：

```sh
git config --local core.hooksPath .githooks
```

线上真实验证需先完成本机登录，并在仓库外准备权限为 `600` 的私有配置文件（切勿提交到仓库）：

1. **读取、下载与登录引导验证**：
   ```sh
   npm run verify:live -- /本机私有目录/target.json
   node scripts/verify-login-flow.mjs /本机私有目录/target.json
   ```
   基础检查只需 `{ "url": "https://doc.weixin.qq.com/smartsheet/your_document_id" }`。若加上 `--browser` 运行浏览器登录恢复验证或运行 `scripts/verify-codex-login.mjs`，还需提供至少含一条记录的 `sheet_id`（或使用含 `tab` 参数的 URL）及非空 `fields` 数组：
   ```json
   {
     "url": "https://doc.weixin.qq.com/smartsheet/your_document_id",
     "sheet_id": "sheet_id_from_structure",
     "fields": ["field_id_from_structure"]
   }
   ```
2. **专用表写入验证**（仅限专门用于测试的智能表格，勿填入业务表）：
   ```json
   {
     "allow_test_writes": true,
     "title": "MCP 写入验收 YYYY-MM-DD",
     "url": "https://doc.weixin.qq.com/smartsheet/your_test_document_id"
   }
   ```
   ```sh
   node scripts/verify-write.mjs /本机私有目录/write-config.json
   ```
   传入 `url` 时会校验表名完全一致，不传 `url` 时自动新建测试表。若中途报错，请先查看私有目录下的报告，不要对结果未知的写操作直接重跑。
3. **整表移入回收站验证**（需使用另一张单独授权删除的测试表）：
   ```json
   {
     "allow_test_delete": true,
     "title": "MCP 删除验收 YYYY-MM-DD",
     "url": "https://doc.weixin.qq.com/smartsheet/your_delete_test_document_id",
     "preserve_urls": ["https://doc.weixin.qq.com/smartsheet/your_retained_document_id"]
   }
   ```
   ```sh
   node scripts/verify-delete-table.mjs /本机私有目录/delete-config.json
   ```
   若删除结果不确定，可在配置中加入 `"check_only": true` 进行只读复核，不要直接重复运行删除。

依赖安全审计建议使用 npm 官方源（部分镜像源未实现 audit 接口）：

```sh
npm audit --registry=https://registry.npmjs.org
```

## npm 发布（维护者）

在源码仓库根目录安装开发依赖后执行发布检查：

```sh
npm ci
npm run check
npm test
npm run check:public
npm run check:public -- --history
npm audit --registry=https://registry.npmjs.org/
npm pack --dry-run
npm publish --dry-run
```

`prepack` 会自动构建 TypeScript，`npm publish --dry-run` 会演练发布流程但不上传。打包清单应仅包含 `dist/`、`examples/`、`README.md`、`LICENSE`、`SECURITY.md`、`VALIDATION.md` 和 `package.json`，不得包含登录态、Chrome profile、下载文件、私有配置或报告。安装 npm 包时只需运行依赖，不会在使用者机器上编译 TypeScript。

准备好 npm 账号并开启双重认证后，按 [npm 官方发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/) 完成浏览器登录，再正式发布：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish
```

终端无法自动打开浏览器时，使用 `npm publish --browser=false`，按终端给出的 npm 链接手动完成 2FA；发布进程会等待认证结果。

`publishConfig` 已指定 npm 官方源和公开访问。`prepublishOnly` 会在正式发布前重新运行类型检查、单元测试和当前公开文件检查，失败则中止发布。当前首次发布版本为 `0.4.0`；后续发布须使用新的版本号；安装示例使用 `@latest`，无需随版本修改。MCP 服务版本自动读取 `package.json`，无需在源码中重复维护。正式发布后，核对公开版本：

```sh
npm view wecom-smarttable-mcp@latest version --registry=https://registry.npmjs.org/
```

详细的协议分析与验证记录见 [VALIDATION.md](VALIDATION.md)。

## 技术说明

- 登录与会话持久化基于 Playwright 的持久化浏览器上下文（`launchPersistentContext`），使用独立 Chrome profile 并在本地保存必要 Cookie。
- 数据读写直接对接企业微信文档网页端协议（`/dop-api/` 与 `/webdisk/` 相关接口），与企业微信开放平台需应用 `access_token` 的服务端 API 相互独立。
- MCP 服务端基于官方 [`@modelcontextprotocol/server`](https://ts.sdk.modelcontextprotocol.io/v2/) 实现。

## 许可证

本项目代码采用 [MIT License](LICENSE) 开源，第三方依赖遵循各自原有许可证。
