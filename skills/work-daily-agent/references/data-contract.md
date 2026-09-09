# 数据契约

仅在需要生成日报、自定义展示或排查数据口径时读取。

## 查询来源

`context`、`events` 和 `report context` 返回：

- `live=true, source=application`：数据来自正在运行的桌面应用，包含已落库、待写入和当前进行中的事件。
- `live=false, source=sqlite`：直接读取 SQLite，只包含已落库事件。查询当天时，尚未结束的最后一段活动可能缺失，必须保留 `warning` 提示。

CLI 只在没有显式 `--db` 时尝试应用 Socket。传入 `--db` 表示测试或排查，始终直接读取该数据库。

## 多日查询

`--from` 和 `--to` 都包含当天。调用者应将用户的完整范围传给一次 CLI 命令；CLI 内部以 7 个自然日为一批执行 SQLite 范围查询，将事件按 `Asia/Shanghai` 的日界线裁剪后再按日处理。`chunk_count` 只表示这次命令的内部数据库批次数，不表示应拆分命令或输出入口。跨零点事件可在两天的记录中各出现一次，但范围总时长不重复。

查询范围包含今天时，CLI 使用现有 Socket 单独取得今天数据并替换 SQLite 快照；Socket 不可用时保留当天不完整警告。历史日期不通过 Socket 返回大范围数据。

范围 `context` 默认使用 `detail=summary`，只返回范围总计、每日摘要、应用用时和有限的主要活动；`--detail full` 将每天完整 context 写入本地目录，标准输出只返回路径和范围元数据。

范围 `report context` 始终接收用户的完整日期范围，内部使用相同的 7 天 SQLite 查询批次。每个批次完成后按应用标识和窗口标题聚合，再合并到全范围结果；原始事件不会累计到最终模型输入。

```json
{
  "schema_version": 1,
  "kind": "range",
  "from": "2026-09-01",
  "to": "2026-09-10",
  "timezone": "Asia/Shanghai",
  "chunk_days": 7,
  "detail": "summary",
  "totals": {
    "day_count": 10,
    "active_day_count": 8,
    "event_count": 3200,
    "recorded_duration_ms": 288000000,
    "application_count": 12
  },
  "usage": [],
  "days": [],
  "warnings": []
}
```

`event_count` 是各日裁剪后事件数的合计；同一原始事件如果跨零点，会在两天各计一条。`recorded_duration_ms` 使用裁剪后时长，不会重复。

## Context 结构

```json
{
  "schema_version": 1,
  "date": "2026-09-07",
  "timezone": "Asia/Shanghai",
  "live": true,
  "source": "application",
  "warning": null,
  "totals": {
    "event_count": 12,
    "recorded_duration_ms": 7200000,
    "application_count": 4
  },
  "events": [],
  "activity_blocks": [],
  "usage": []
}
```

### events

- `id`：已落库事件为正整数；运行态事件为负整数。
- `start_ts`、`end_ts`：Unix 秒。
- `app`、`bundle_id`、`window_title`：应用和窗口信息。
- `duration_ms`：按查询日期边界裁剪后的毫秒数。
- `ongoing`：是否仍在进行。

### activity_blocks

用于行为轨迹。仅相邻且应用相同的事件会合并，合并后不足 30 秒的块不展示。短事件仍保留在 `events` 和 `usage` 中。

### usage

按应用聚合完整事件，包含系统空闲。`ratio` 的分母是当天全部已记录时长。每个应用的 `details` 按时长降序排列。

## 日报上下文

`report context` 与供轨迹渲染使用的通用 `context` 相互独立，不返回 `activity_blocks` 或 `usage.details`。

单日使用 `input_mode=raw_events`，按时间正序返回精简原始事件。`event_fields` 定义每条 `events` 数据行的字段顺序，依次为 `start_ts`、`end_ts`、`app`、`window_title`、`duration_ms` 和 `ongoing`，避免在每条记录中重复字段名，也不发送数据库标识及派生展示结构。

多日使用 `input_mode=app_title_aggregates`，返回：

- `chunk_days`、`chunk_count`：本次命令的内部 SQLite 查询批次信息。
- `day_fields` 和 `days`：定义并保存每天的事件数、记录时长、数据来源和警告，不包含原始事件。
- `aggregate_fields` 和 `aggregates`：定义并保存按应用标识和窗口标题跨所有批次合并的结果，包含应用名、窗口标题、累计时长、事件数、活跃天数、首次时间和最后时间。
- `totals`：完整范围的天数、事件数、记录时长、应用数和聚合项数。

`report context` 本身始终为只读操作。单日日报生成后，Agent 默认通过标准输入调用 `report save --stdin --no-export`，写入单日日报表但不创建报告文件；多日总结默认不调用 `report save`。只有用户明确要求导出时才创建 Markdown。

## 日报证据边界

窗口标题能证明用户在某个时间打开了相关页面或文件，不能单独证明某项工作已经完成、发布或交付。生成日报时使用保守措辞，不补充记录中未出现的人名、项目、结果或数量。
