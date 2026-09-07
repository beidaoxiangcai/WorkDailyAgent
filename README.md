# WorkDailyAgent

WorkDailyAgent 是一个 macOS 本地工作记录与日报应用。项目包含 React + TypeScript + Vite 前端、Tauri/Rust 桌面端、可直接调用的 CLI（命令行工具），以及中文 Agent Skill。

## 主要能力

- 在本机采集前台应用和窗口活动。
- 按单日或日期范围查询原始记录与适合 Agent 分析的结构化上下文。
- 独立生成可离线打开的行为轨迹 HTML，默认样式与应用内活动分析页保持同一数据口径。
- 由 Agent 基于真实记录生成中文日报，并默认保存到应用的日报列表。
- 临时使用自定义 HTML 样式，或保存为后续可复用的本机样式。

行为轨迹和日报是两个独立操作，不会因生成其中一个而自动生成另一个。

## 安装 Agent Skill

已知 GitHub 地址的用户可用 Skills CLI 安装：

```bash
CODEX_HOME="$HOME/.agents" npx skills add \
  https://github.com/beidaoxiangcai/WorkDailyAgent \
  --skill work-daily-agent -g -a codex -y
```

安装后可对 Agent 说：

```text
使用 $work-daily-agent 查看今天的行为轨迹。
使用 $work-daily-agent 根据今天的记录生成并保存日报。
```

Skill 只能从已知 GitHub 地址安装。是否能被所有人直接搜索到，取决于后续是否发布到公共 Skill 目录，不由仓库内文件自动完成。

## 直接使用 CLI

无需预先克隆仓库：

```bash
npx --yes --package=github:beidaoxiangcai/WorkDailyAgent \
  workdaily-agent doctor

npx --yes --package=github:beidaoxiangcai/WorkDailyAgent \
  workdaily-agent start
```

`start` 会在需要时下载源码和安装依赖，然后启动桌面应用。需要 macOS 12+、Node.js 22.12+、Rust 和 Xcode Command Line Tools。

常用命令：

```bash
workdaily-agent events --date today
workdaily-agent context --date today
workdaily-agent timeline show --date today --no-open --json
workdaily-agent context --from 2026-09-01 --to 2026-09-10
workdaily-agent timeline show --from 2026-09-01 --to 2026-09-10 --no-open --json
workdaily-agent report list --date 2026-09-07
workdaily-agent style list
```

多日查询的首尾日期都包含在结果中，用户的完整范围只需执行一次 CLI 命令。CLI 内部每个 SQLite 查询批次最多读取 7 个自然日，该阈值不是命令或输出范围上限。每天的行为轨迹写入独立数据文件，唯一的范围 `index.html` 在展开某天时才加载该日明细。7 天以内默认展开，更长范围默认折叠。多日轨迹为可离线打开的目录，移动或归档时需保留其中的 `index.html`、`assets/` 和 `data/`。

## 本地开发

```bash
npm ci
npm run tauri dev
```

验证命令：

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

更详细的 CLI 数据口径、安全边界和兼容方案见 `docs/`。
