# 2026.10.5 修正补丁 —— 验证记录（V1/V2/V3 展示与回填优化版）

本仓库是 **`feishu-tool-aggregation-wayE` 2026.10.5 补丁的修正 + 展示/回填优化版本**。部署记录已脱敏；仓库只随附补丁、安装器、适配器、测试与文档。

## 1. 产物与哈希

| 文件 | SHA-256 |
| --- | --- |
| `patches/2026.10.5/feishu-tool-aggregation.patch` | `ae10e953e2d8e5b41d7e5089d3fae27a13a265a83e95e867cddcc8b2845fc046` |
| `patches/2026.10.5/patched.mjs` | `2b3af8e44abc4bd580ccdf27a77ba2e85e53c2a46051fedfa6d5c01ba9270c68` |
| `patches/2026.10.5/original.mjs`（未改动） | `72a0a198e31e71e4690e2b86296d53983863e99e8d3a0872ac4cbb83aefe3bfe` |

- 补丁：**26 hunks**，`original.mjs` + patch → `patched.mjs` 正/反向 **byte-exact**，offset 全 +0。
- `original.mjs` 与 npm 官方 `@openclaw/feishu@2026.10.5` 的 `dist/.setup/monitor.account-*.mjs` 完全一致。
- `patches/SHA256SUMS`、`install.sh`、`README.md` 版本表均已同步。

## 2. 本次 V1/V2/V3 优化内容

### V1 — 展示正确性与延迟（P1）
| 优化 | 实现 |
| --- | --- |
| **提前开卡** | `onReplyStart` 在 preview streaming 开启时预热卡片（`prewarmCard` 可关）；卡片创建与工具执行重叠，消除 1–2s 空窗 |
| **预热状态** | 卡片 ready 后立即显示 `⏳ 已收到，正在处理…`（`progressTexts.prewarm`），首个工具/旁白/正文出现时自动清除，避免空白预热卡 |
| **等待行持久化** | `⏳ 已执行 N 个工具…` 在助手分段/中间文本开始时不再被清空（只清 item/compaction/narration 临时行），持续显示并随工具计数更新，仅在 final/关闭时移除 |
| **展示打磨 batch 1** | 初始化/处理状态跨 assistant start 保留，消除第二段空白；状态区紧凑为“主行 + 至多一行旁白”；等待行增加最后工具与耗时（5s 刷新）；旁白上限可配，默认 120 字 |
| **展示打磨 batch 2** | 耗时刷新默认 15s 可配（`toolElapsedRefreshMs`），关闭 elapsed 不启动定时器；`cardStatusPosition` 支持 status 上下 A/B；reasoning 预览限行（默认 12 行）且 final 默认隐藏 thinking；可选 final 工具摘要（默认关闭） |
| **单卡生命周期修复** | onIdle 只代表 dispatcher 分段空闲；活动卡保持到 final，避免预热卡提前关闭后 block/final 新建重复卡片；onCleanup 兜底 silent/abort |
| **正文/ final 去重** | block 文本使用 `mergeStreamingText` 合并，避免正文重复；`deliveredFinalTexts` 记录 fallback final 内容，`ensureVisibleStreamingDelivery` 记录 final fallback，堵住重复 final 路径 |
| **展示/性能收尾** | final summary 去 markdown/中文兜底；工具后状态切到“生成回复中”；close 删除 status 元素消除空隙；旁白默认 80 字；耗时刷新与工具事件合并；content/status 脏字段拆分 |
| **最新态回填** | `flushCardUpdate` 向队列传 render provider，队列在 `await streamingStartPromise` 之后渲染**最新**展示状态；卡片创建期间更新合并为一次 pending flush（`cardFlushPending`），不再重放旧帧 |
| **ticker 打磨** | 相同旁白去重、`truncateDisplayText` 按 code point 截断（修复代理对截断），max chars 可配 |
| **进度计数** | 引入 `aggregatedToolTotal` 运行总数，去掉每个工具事件的全 map `reduce` |

### V2 — 内容/状态分离 + 结构化状态
| 优化 | 实现 |
| --- | --- |
| **双元素卡片** | 卡片 JSON 增加 `element_id:"status"` markdown 元素；`session.updateStatus()` 走 `/cards/{id}/elements/status/content`；等待行/旁白只更新 status 元素，答案流式只更新 content 元素 |
| **状态失败回退** | status 元素更新失败时标记 `statusUnavailable`，自动把状态合并进 content 元素（不会丢等待行/旁白）；`cardStatusElement:false` 可强制 content-only |
| **结构化状态** | `waitingLine`/`narrationLine`/`itemStatusLine`/`compactionLine` 分开，`buildStatusText()` 按优先级合并并限制 `STATUS_MAX_CHARS=600`，避免互相覆盖 |
| **等待行增强** | 可选 `showLastToolLabel`（`（最后：Read）`）；`progressTexts.toolWaiting/toolCompleted/compacting` 可配置文案 |
| **空卡防护** | 预热后 silent/skip 回合若没有任何内容/工具/旁白，关闭时直接 `discard()` 卡片，避免空卡片残留 |

### V3 — 稳定性/配置/可观测性
| 优化 | 实现 |
| --- | --- |
| **backoff 缩短** | `STREAMING_START_FAILURE_BACKOFF_MS` 60s → **15s** |
| **hold 可配** | `cardIdleHoldMs`（2–30s，默认 8000） |
| **状态元素开关** | `cardStatusElement`（默认 true） |
| **启动耗时日志** | `streaming card ready in {ms}ms` |
| **文案/国际化的基础** | `progressTexts` 配置覆盖默认中文文案 |
| **安全截断** | code-point 级 `truncateDisplayText`，避免 emoji 被切半 |
| **导航/清理** | 保留 P1/P2 修复；死代码清理；运行总数计数 |

## 3. 本地验证结果（全部实际执行，Node v24.21.0）

### 3.1 机械验证

| 检查 | 结果 |
| --- | --- |
| `node --check patched.mjs` | exit 0 |
| 补丁应用 | 26 hunks，offset 全 +0，forward **byte-exact** |
| 反向应用 | reverse **byte-exact** |
| `SHA256SUMS` | 9/9 一致（10.1/10.2 未改动） |

### 3.2 2026.10.5 专用测试（`tests/run-all.mjs`，8 套件）

```
54 passed, 0 failed (2026.10.5 parser/delivery)
26 passed, 0 failed (2026.10.5 waiting-line/aggregation)
26 passed, 0 failed (2026.10.5 block-fold/status-line)
33 passed, 0 failed (2026.10.5 execution harness)
31 passed, 0 failed (2026.10.5 idle/timer/content)
32 passed, 0 failed (2026.10.5 narration ticker)
55 passed, 0 failed (2026.10.5 display/backfill/session)
96 passed, 0 failed (2026.10.5 structural audit)
8/8 suites passed, 0 failed — 353 assertions
```

新增 `test-display-backfill-105.mjs` 覆盖：
- `queueFeishuStreamingUpdate` 的 render provider **在 start 之后**执行（最新态回填）；
- 状态更新失败触发 content fallback 回调；
- 卡片 JSON status 元素、`updateStatus`、`elements/status/content` 路径、关闭清空 status、节流、配置开关；
- 提前开卡、backoff=15s、hold 配置、progressTexts、延迟日志；
- 状态字段合并顺序 `waiting → narration → item → compaction`。

其他套件覆盖：真实 emitter 解析、叙述/媒体兜底、等待行/运行总数/epoch 竞态、状态行归属、hold 生命周期、旁白 ticker（去重/安全截断/竞态/清空）、结构审计。

### 3.3 版本策略

仓库只保留 **2026.10.5 作为初始版本**；旧版本补丁/测试已移出仓库（本地归档），不再随仓库分发。未来版本通过锚点适配器、`patches/MANIFEST.json` 和 CI 矩阵追加。

## 4. 参考部署记录（已脱敏）

| 项 | 值 |
| --- | --- |
| 环境 | OpenClaw 2026.10.5，Linux，真实 Feishu 租户 |
| 部署方式 | 恢复 pristine 备份 → 运行 `install.sh`（备份 → patch → 哈希校验） |
| 部署后目标哈希 | **`1d9eb846…`** |
| Gateway | 重启后 `active`；`/health` = **200**；Feishu websocket 已启动 |
| 幂等性 | 再次运行 installer → `already patched (plugin build 2026.10.5)` |

## 5. 配置项（可选）

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `prewarmCard` | `true` | 回复开始时预热卡片（preview streaming 开启时） |
| `cardStatusElement` | `true` | 使用 CardKit `status` 元素；`false` 合并进 content |
| `cardIdleHoldMs` | `8000` | 工具批次 hold 窗口（2–30s） |
| `progressTexts.toolWaiting` | `⏳ 已执行 {count} 个工具，等待中…` | 等待行模板 |
| `progressTexts.toolCompleted` | `✅ 已执行 {count} 个工具` | 工具型回合收尾 |
| `progressTexts.compacting` | `📦 **Compacting context...**` | compaction 行 |
| `showLastToolLabel` | `false` | 等待行追加 `（最后：Read）` |

## 6. 未覆盖 / 需要 live 验证的点

- **双元素 CardKit 行为**：API 探针 + 实机日志均已确认 create/update/clear 正常（`Card status element update OK`，无失败）。自动回退（状态合并回 content）保留，`cardStatusElement:false` 可强制 content-only。
- **预热状态**：已改为卡片 ready 即显示初始状态；等待下一次实机视觉确认。
- **视觉验收**：建议实际发一条多工具消息确认：预热后等待行即时出现；状态行与答案互不覆盖；旁白 ticker 单行；工具型回合 ✅ 收尾；silent 回合无空卡。
- **`verboseLevel:on` 仍是前提**；`verboseLevel:full` 的 shell detail-only 文本仍走 legacy（limitation）。
- MCP/插件自定义工具仍走 legacy（不会静默丢失）。
- 其余 P3 nit（install.sh 边角、测试弱断言等）未在本轮范围内。
- 升级 OpenClaw/插件会重写 `dist/`，需重新应用。

## 7. 目录清单

```
fixed/
  README.md                    项目说明 / 安装 / 适配流程
  VERIFICATION.md              本文件
  install.sh                   单版本精确哈希安装器（备份 + 回滚）
  patches/
    MANIFEST.json              版本哈希/状态清单
    2026.10.5/
      original.mjs             pristine（本地有，仓库不随附）
      patched.mjs              patched（本地有，仓库不随附）
      feishu-tool-aggregation.patch   当前 25-hunk 补丁
    SHA256SUMS                 本地校验
  tests/                       2026.10.5 的 8 套件
  tools/
    adapt_patch.py             锚点适配器
    verify_patch.py            严格补丁校验
    finalize.py                本地生成/同步哈希与 manifest
  .github/workflows/verify.yml CI 矩阵
  旧版本（2026.10.1/10.2）     已移出仓库，仅本地归档
```

---
*验证时间：2026-10-19（Asia/Shanghai）。运行时：Node v24.21.0 / Python 3.12.14（DSH 捆绑）。*
