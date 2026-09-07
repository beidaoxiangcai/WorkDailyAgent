# 安装与启动

## 安装 Skill

从公开 GitHub 仓库安装到 Codex 用户级 Skill 目录：

```bash
CODEX_HOME="$HOME/.agents" npx skills add \
  https://github.com/beidaoxiangcai/WorkDailyAgent \
  --skill work-daily-agent -g -a codex -y
```

安装目标为 `$HOME/.agents/skills/work-daily-agent`。

## 直接运行 CLI

无需预先克隆仓库：

```bash
npx --yes --package=github:beidaoxiangcai/WorkDailyAgent \
  workdaily-agent doctor

npx --yes --package=github:beidaoxiangcai/WorkDailyAgent \
  workdaily-agent start
```

`start` 首次运行会准备项目依赖，后续复用已有源码和构建缓存。当前应用仅支持 macOS 12 及以上版本，并需要 Node.js 22.12、Rust 和 Xcode Command Line Tools。

## Skill 内调用

Agent 不应假设全局 `workdaily-agent` 已加入 PATH。始终调用 Skill 自带脚本：

```bash
node "$SKILL_DIR/scripts/workdaily-agent.mjs" doctor --json
```

下载依赖、克隆仓库或启动桌面程序可能触发宿主的网络或桌面操作审批，应正常请求授权，不绕过审批。
