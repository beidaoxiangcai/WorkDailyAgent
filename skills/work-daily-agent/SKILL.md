---
name: work-daily-agent
description: 使用 WorkDailyAgent 在 macOS 上采集工作活动、查询单日或多日记录、生成交互式行为轨迹 HTML、管理可复用展示样式，以及基于真实记录生成并保存中文日报。适用于用户提到工作记录、电脑活动、行为轨迹、应用用时或工作日报时；不用于监控其他用户或推断记录中不存在的工作内容。
---

# WorkDailyAgent

使用本 Skill 目录下的 `scripts/workdaily-agent.mjs` 完成确定性操作。将当前 `SKILL.md` 所在目录记为 `SKILL_DIR`，通过以下形式调用：

```bash
node "$SKILL_DIR/scripts/workdaily-agent.mjs" <command>
```

## 路由

- 用户要求安装、检查或启动应用：运行 `doctor`，按需运行 `setup` 或 `start`。仅在用户要求时下载依赖或启动桌面应用。
- 用户要求查看原始记录：单日运行 `events --date <date>`；多日运行 `events --from <date> --to <date>`，完整记录按日写入本地目录。除非用户明确要求，不展开全部窗口标题。
- 用户要求查看行为轨迹：单日运行 `timeline show --date <date> --no-open --json`；多日将用户的完整日期范围传给一次 `timeline show --from <date> --to <date> --no-open --json`。只打开并返回该命令生成的唯一 `index.html` 入口，不生成日报。
- 用户要求生成单日日报：运行 `report context --date <date>`，由当前 Agent 基于返回的精简原始事件生成中文日报；将日报正文通过标准输入传给 `report save --date <date> --stdin --no-export`，保存到应用后直接在对话中回答。默认不创建 Markdown 文件，也不生成行为轨迹。
- 用户要求生成多日总结：将完整日期范围传给一次 `report context --from <date> --to <date>`，由当前 Agent 基于返回的应用标题聚合结果生成中文总结并直接在对话中回答。默认不创建文件、不调用 `report save`。
- 用户明确要求导出 Markdown 时，才改用 `report save --date <date> --file <markdown>` 或省略 `--no-export`；`report save` 不用于保存多日总结。
- 用户同时要求日报和轨迹时，分别执行上述两个流程。
- 用户要求查询历史日报：运行 `report list` 或 `report show <id>`。

日期未指定时使用 `today`。日期解释与当前应用一致，使用 `Asia/Shanghai` 时区。范围查询的 `--from` 和 `--to` 都包含当天，且不得与 `--date` 同时使用。

## 日报规则

1. 只使用 `report context` 返回的应用名、窗口标题、时间和时长作为事实依据。
2. 可以合并同一项目的连续活动并概括动作，但不得把窗口标题推断成已完成成果。
3. 信息不足时使用“处理”“查看”“沟通”等中性表达，或明确说明记录不足。
4. 默认输出 2 至 5 条“今日完成”，按项目或时间组织，语言简洁。
5. 单日日报默认写入应用现有 `reports` 表但不导出文件；多日总结默认不保存。两者都直接在对话中回答，只有用户明确要求导出时才创建 Markdown。单日日报保存失败时仍返回已生成内容并明确说明未保存。
6. 不读取或输出 DeepSeek API Key；Agent 生成日报不依赖应用内 DeepSeek 配置。

单日 `report context` 只返回生成日报所需的原始事件字段，不返回行为轨迹块或应用明细副本。为减少 Token，事件和聚合项使用紧凑数据行，字段顺序分别由同一结果中的 `event_fields`、`day_fields` 和 `aggregate_fields` 定义。多日 `report context` 在单次命令内按 7 个自然日分批查询，逐批按应用标识和窗口标题聚合，再跨批次合并为唯一模型输入；7 天不是 Agent 调用或用户范围上限。不得为了生成多日总结而拆成多次 CLI 调用。

需要理解查询字段、运行中事件或降级行为时，读取 [references/data-contract.md](references/data-contract.md)。

## 行为轨迹与样式

默认模板复用桌面应用的两段式时间轴、应用稳定配色、环形占比和可展开明细。单日 HTML 为自包含文件；多日 HTML 为可离线打开的本地目录，两者都不访问外部资源。

- 7 天仅是 CLI 内部的 SQLite 查询分批大小，不是 Agent 命令、用户查询或 HTML 的范围上限。不得因范围超过 7 天而拆成多次 `timeline show`；CLI 会在单次命令中分批查询，并按天写入供共享渲染器按需加载的数据 JS。
- 7 天以内默认展开，超过 7 天默认折叠；只有用户明确要求时才使用 `--expand-all` 或 `--collapse-all` 覆盖。

- 用户只要求临时改变样式：创建含数据占位符的 HTML，运行 `timeline show --template <file> --no-open --json`，不要保存为模板。
- 用户明确要求保存样式：运行 `style save --name <name> --template <file>`。
- 用户说“以后都用”或“设为默认”：保存时增加 `--set-default`，或运行 `style set-default <name>`。
- 多日自定义样式使用 `style save --scope range`，与单日默认样式分开管理。
- 删除样式必须是用户明确请求，并使用 `style delete <name> --yes`。

创建或修改自定义模板前，读取 [references/template-contract.md](references/template-contract.md)。模板只保存布局和样式，不嵌入用户活动记录。

## 安全与停止条件

- 查询优先使用正在运行的应用提供的本机 Socket，以包含进行中事件；不可用时只读 SQLite，并保留 CLI 返回的 `warning`。
- 除日报保存和用户明确要求的模板保存外，不修改数据库或应用数据。
- 不通过本 Skill 清空活动记录、修改黑名单或管理密钥。
- 辅助功能权限必须由用户在 macOS 系统设置中授予，不尝试绕过。
- 平台、依赖或数据库缺失时，报告 `doctor` 结果并给出下一步；不要伪造空记录或日报。
- 安装和启动细节见 [references/installation.md](references/installation.md)。
