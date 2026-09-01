# DeepSeek API Key 配置技术方案

## 1. 实现目标

在现有 Tauri 2 + React 19 应用中增加 DeepSeek API Key 配置，通过 macOS Keychain 保护静态密钥，并在未配置时提供明确的设置引导。

本期不抽象多服务商适配层，不修改 SQLite 表结构。

## 2. 数据流

```text
设置页输入 Key
  → Tauri command
  → DeepSeek 最小请求验证
  → 验证成功后写入 macOS Keychain
  → 返回脱敏状态

生成日报
  → Keychain 读取 Key
  → 无 Key 时尝试 DEEPSEEK_API_KEY
  → 仍无 Key则返回 API_KEY_NOT_CONFIGURED
  → 前端显示提醒并提供“去设置”
```

## 3. 后端设计

### 3.1 Secret Store

新增 `secret_store.rs` 封装：

```text
service = com.workdaily.agent.llm
account = deepseek-api-key
```

读取顺序为 Keychain、`DEEPSEEK_API_KEY`、未配置。状态结构只包含：

```rust
struct ApiKeyStatus {
    configured: bool,
    source: Option<&'static str>,
    last_four: Option<String>,
}
```

使用 `keyring 3.6.3` 的 `apple-native` 功能接入 macOS Keychain。该版本最低 Rust 版本为 1.75，与项目的 Rust 1.77.2 约束兼容。

### 3.2 Tauri 命令

| 命令 | 用途 | 返回内容 |
|------|------|----------|
| `get_api_key_status` | 读取配置状态 | 是否配置、来源、末四位 |
| `save_and_verify_api_key` | 验证并保存候选 Key | 保存后的脱敏状态 |
| `delete_api_key` | 删除 Keychain Key | 删除后的脱敏状态 |

保存流程先验证后写入，因此无效 Key 不会覆盖原有有效 Key。

### 3.3 DeepSeek 请求

- 固定地址：`https://api.deepseek.com/chat/completions`。
- 固定模型：`deepseek-v4-flash`。
- 验证请求关闭 thinking，并将 `max_tokens` 限制为 4。
- 认证失败、余额不足、限流和服务异常映射为本地文案。
- 不记录 Authorization Header 或服务商响应体。

### 3.4 缺少 Key 错误

`generate_daily_report` 在查询和生成前解析 Key。未配置时返回稳定错误码 `API_KEY_NOT_CONFIGURED`，前端只对该错误展示配置提醒；其他错误沿用页面错误区域。

## 4. 前端设计

### 4.1 设置页

`SettingsPage` 增加 Key 状态、本次输入、显示开关、保存状态和页内反馈。完整 Key 只保存在组件状态中，保存成功后立即清空。

### 4.2 跳转与聚焦

根组件维护递增的 `focusApiKeyRequest`。用户在提醒中点击“去设置”时：

1. 关闭提醒。
2. 更新聚焦请求。
3. 切换到设置页。
4. 设置页挂载后用 `useRef` 获取输入节点。
5. 调用 `scrollIntoView()` 和 `focus()`。

未配置 Key 的提醒使用 `role="alertdialog"` 和 `aria-modal="true"`，主操作为“去设置”，次操作为“取消”，不额外显示 Toast。

## 5. 安全边界

- 完整 Key 不通过状态命令返回前端。
- Key 不进入 SQLite、文件、URL、日志或错误文案。
- Keychain 只保护静态存储；调用时 Key 会短暂存在于进程内存并发送给 DeepSeek。
- Keychain 读取失败不会回退到明文存储。
- 删除 Keychain Key 不删除历史日报；若环境变量仍存在，生成继续使用环境变量。

## 6. 验证方案

- 前端：TypeScript 构建、静态检查、现有数据测试。
- 后端：格式化检查、Clippy、Rust 测试。
- 交互：未配置提醒、取消、去设置、滚动聚焦、输入显示切换。
- Keychain：有效 Key 保存/更新/删除、只返回末四位。
- 安全：检查数据库、日志和前端状态不包含完整 Key。

## 7. 官方参考

- [Tauri 2 从前端调用 Rust](https://v2.tauri.app/zh-cn/develop/calling-rust/)
- [React 19 useRef](https://react.dev/reference/react/useRef#manipulating-the-dom-with-a-ref)
- [keyring 3.6.3 Entry API](https://docs.rs/keyring/3.6.3/keyring/struct.Entry.html)
- [keyring 3.6.3 Cargo 元数据](https://docs.rs/crate/keyring/3.6.3/source/Cargo.toml)
- [DeepSeek API 快速入门](https://api-docs.deepseek.com/)
- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
