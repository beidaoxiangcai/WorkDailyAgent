# Agent Skill 与 CLI 技术方案

## 1. 实现范围

在现有桌面应用外增加三层能力：

```text
中文 Agent Skill
  → Node.js CLI（参数解析、查询、HTML 渲染、样式和日报保存）
  → 应用本机 Unix Socket（优先）或 SQLite（降级）
```

不修改前端页面、现有 Tauri 命令签名、数据库表结构和事件采集逻辑。

## 2. 已有能力与新增能力

| 类型 | 已有 | 新增 |
|------|------|------|
| 项目运行 | `npm run tauri dev`、`npm run tauri build` | `workdaily-agent setup/start/build` 自动定位或准备源码 |
| 数据查询 | 前端通过 Tauri `query_events` 查询 | `events/context` 以 JSON 向 Agent 提供同口径数据 |
| 进行中事件 | `AppState.runtime_events` 供应用内查询 | Unix Socket 复用 `query_day_events` 查询 |
| 活动分析 | React 页面内时间轴与占比 | CLI 默认 HTML 模板、离线快照和样式管理 |
| 日报 | 应用内 DeepSeek 生成并保存 | Agent 用 `report context` 生成；单日通过标准输入保存且不导出文件，多日只回答 |
| Skill | 无 | `skills/work-daily-agent` 中文指令、模板和参考文档 |

## 3. CLI 命令

| 命令 | 作用 |
|------|------|
| `doctor` | 检查 macOS、Node.js、npm、Git、Rust、Xcode 工具、源码、数据库和 Socket |
| `setup` | 定位本地源码，或克隆至应用数据目录，并安装开发依赖 |
| `start` / `build` | 使用应用数据目录内的 Cargo 构建缓存启动或构建 |
| `events` | 返回单日标准化事件，或按日导出多日事件 |
| `context` | 返回单日完整 JSON，或多日摘要/完整导出 |
| `timeline show` | 生成单日 HTML 或按需加载的多日轨迹目录 |
| `style list/save/set-default/delete` | 管理可复用本机 HTML 模板 |
| `report context/list/show/save` | 准备日报模型输入、查询日报，或从标准输入/文件保存 Agent 生成的单日日报 |

`events`、`context`、`report context` 和 `timeline show` 同时支持单日 `--date` 与多日 `--from/--to`。两组参数互斥，范围查询的首尾日期都包含在结果中。Agent 将用户完整范围传给一次 CLI 命令，不按数据库分批大小拆分调用。

## 4. 本机应用桥接

- 应用启动时在应用数据目录创建 `workdaily-agent.sock`。
- Socket 权限设为 `0600`，仅当前系统用户可读写，不监听 TCP 端口。
- 只接受 `ping`、`query_events`、`get_reports` 和 `save_report` 四类白名单请求。
- `query_events` 直接复用现有 `query_day_events`，因此同时包含 SQLite 事件、待写事件和当前事件。
- Socket 创建失败只记录警告，桌面应用继续运行。

## 5. SQLite 降级

Socket 不可用时，CLI 通过 Node.js 内置 `node:sqlite` 直接查询数据库。事件查询使用只读模式，日报保存使用参数化 `INSERT`。

直读 SQLite 看不到内存中未闭合的当前活动。因此查询当天数据时返回 `live=false`、`source=sqlite` 和警告字段；历史日期不需此警告。

## 6. HTML 渲染与模板

- 默认单日模板是自包含 HTML，多日模板只依赖导出目录内的共享渲染器和每日数据，不依赖 CDN 或外部字体。
- CLI 将 `context` JSON 注入唯一的 `{{WORKDAILY_DATA_JSON}}` 占位符。
- 注入前将 `<` 转义为 Unicode 序列，模板通过 `textContent` 渲染应用名和窗口标题。
- 持久化模板保存在应用数据目录的 `templates/<name>` 下，不写入 Skill 目录。
- 生成的 HTML 快照保存在应用数据目录的 `exports/<date>` 下。

### 6.1 多日数据管线

CLI 在单次范围命令内将日期范围分成最多 7 个自然日的连续分块。每个分块使用一次 SQLite 范围查询，结果按上海时区日界线裁剪。每天完成统计后立即写入文件，范围处理器只保留每日摘要和增量应用汇总，不累积全量事件。所有分块完成后才生成该完整范围的唯一 `index.html`。

```text
exports/<from>-to-<to>/behavior-timeline/
├── index.html
├── assets/renderer.js
└── data/YYYY-MM-DD.js
```

`index.html` 只嵌入范围摘要。共享渲染器在用户展开日期时动态加载对应 JS，折叠时删除当日原始数据和明细 DOM。该方式无需本地 HTTP 服务，整个目录可离线复用。新建导出目录使用 `0700` 权限，其中文件使用 `0600` 权限。

多日默认模板使用 `{{WORKDAILY_RANGE_JSON}}`，共享渲染器只通过 DOM API 写入应用名和窗口标题。每日 JS 对 `<`、Unicode 行分隔符和段落分隔符进行转义，输出文件权限为 `0600`。

### 6.2 日报上下文管线

`report context` 不复用包含轨迹和占比派生数据的通用 `context` 输出：

- 单日按时间正序返回精简原始事件，只保留时间、应用、窗口标题、时长和进行中状态。
- 日报上下文使用字段表加数据行的紧凑 JSON，避免为每条事件或聚合项重复输出字段名。
- 多日由一次命令接收完整范围，内部仍以 7 个自然日为一个 SQLite 查询批次。
- 每个批次只在处理期间保留原始事件，并按应用标识和窗口标题生成局部聚合；批次结束后将局部聚合合并到全范围结果。
- 最终模型输入只包含每日计数和跨批次聚合，不包含行为轨迹块、应用明细或每日原始事件。
- `report context` 为只读命令。单日日报默认将正文通过标准输入传给 `report save --stdin --no-export`，只写入日报表而不创建报告文件；多日总结默认只回答、不调用保存命令。原有 `--file` 保存和 Markdown 导出能力继续保留，供用户明确要求导出时使用。

日报上下文管线与 `timeline show` 分离，不改变单日 HTML、多日每日 JS、共享渲染器或按需加载逻辑。

## 7. 打包与安装

- `package.json` 的 `bin` 将 `workdaily-agent` 指向 Skill 内 CLI 脚本。
- `files` 白名单只打包 Skill 和 CLI，避免在 npm 临时缓存目录内安装整套开发依赖。
- `setup` 在应用数据目录克隆完整仓库，然后依据锁文件执行 `npm ci`。
- Agent 在 Skill 内使用相对路径调用脚本，不依赖全局 PATH。
- CLI 优先复用环境变量指定或当前目录中的开发仓库，否则使用托管源码目录。

## 8. 影响范围

- 无数据库迁移。
- 无新增第三方依赖。
- 无前端界面改动。
- 无采集器和合并引擎改动。
- 原有应用内查询和日报生成流程不变。
- 多日历史数据由 CLI 直读 SQLite，范围包含今天时仅复用现有单日 Socket 补充，不扩展 Rust 协议。

## 9. 验证方案

1. 使用固定 SQLite 数据验证查询、空闲重叠归一化和 30 秒行为块阈值。
2. 验证恶意窗口标题不会以 HTML 执行。
3. 验证 Agent 单日日报可从标准输入写入现有 `reports` 表且不生成文件，并验证显式文件导出保持兼容。
4. 运行前端构建、Rust 测试、Skill 结构校验和 npm 打包内容检查。
5. 将 Skill 安装到独立临时目录，从安装后位置执行 `doctor`。
6. 使用跨零点固定数据验证 7 天分块、空白日期、范围汇总和每日 JS 转义。
7. 验证 7 天以内默认展开、8 天及以上默认折叠，以及单日模板回归行为。
8. 验证单日日报上下文不包含派生展示结构，多日聚合可跨 7 天批次合并且查询不写入日报表。
