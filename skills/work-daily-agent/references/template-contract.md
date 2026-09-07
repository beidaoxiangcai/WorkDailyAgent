# HTML 模板契约

仅在用户要求自定义行为轨迹样式时读取。

## 必要条件

模板必须：

1. 是完整、可离线打开的 UTF-8 HTML。
2. 包含且只包含一次 `{{WORKDAILY_DATA_JSON}}`。
3. 将占位符放在 `type="application/json"` 的 `<script>` 中。
4. 使用 `textContent` 或 DOM API 写入应用名和窗口标题，不把这些字段拼进 `innerHTML`。
5. 不加载 CDN、远程字体、图片、脚本、统计代码或其他网络资源。
6. 不包含生成模板时使用的真实工作记录。

推荐数据入口：

```html
<script id="workdaily-data" type="application/json">{{WORKDAILY_DATA_JSON}}</script>
<script>
  const data = JSON.parse(document.getElementById('workdaily-data').textContent)
</script>
```

## 单次样式与复用样式

单次样式直接传入：

```bash
workdaily-agent timeline show --template ./custom.html --no-open --json
```

只有用户明确要求保留时才保存：

```bash
workdaily-agent style save --name dark-dashboard --template ./custom.html
```

用户要求以后默认使用时增加 `--set-default`。模板会保存到 CLI 动态解析的 WorkDailyAgent 应用数据目录，不写死用户名，也不放进 Skill 安装目录。

## 多日模板

多日轨迹模板与单日模板独立，使用唯一占位符 `{{WORKDAILY_RANGE_JSON}}`。自定义时应从内置 `default-range-timeline.html` 调整布局与 CSS，保留共享渲染器使用的 DOM 节点 ID 和本地脚本：

```html
<script id="workdaily-range-data" type="application/json">{{WORKDAILY_RANGE_JSON}}</script>
<script src="assets/renderer.js"></script>
```

共享渲染器从范围摘要创建日期列表，展开日期时加载 `data/YYYY-MM-DD.js`，折叠时清理当日原始数据和明细 DOM。每日数据只能由 CLI 生成，自定义模板不得内嵌真实记录或请求网络资源。

保存和设置多日默认样式：

```bash
workdaily-agent style save --name compact-range --template ./range.html --scope range
workdaily-agent style set-default compact-range --scope range
```

单日与多日默认样式分开保存，更改其中一个不影响另一个。

## 兼容性

当前单日与多日数据版本均为 `schema_version=1`，多日共享渲染器版本为 `renderer_version=2`。自定义模板应在未知字段出现时忽略，在必要字段缺失时展示明确的“模板与数据版本不兼容”提示，不生成错误统计。
