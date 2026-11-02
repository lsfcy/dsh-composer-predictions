# dsh-composer-predictions

[![CI](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml/badge.svg)](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml)

给 DeepSeek Harness 的输入框补上“下一句预测”：一轮对话结束后，在空的输入框里用灰字显示
你接下来可能发送的消息。**Tab** 填入草稿，**Esc** 或开始打字即忽略。不会自动发送。

[English](README.en.md) | 中文 · [在线试玩](https://lsfcy.github.io/dsh-composer-predictions/demo/dsh.html)

## 示例

用户要求把 A/B 的成本、延迟比较整理成可粘贴的表格，助手只给了文字结论。空输入框里可能出现灰字：

> 把刚才的比较改成表格，保留成本和延迟两项。

按 Tab，它变成可编辑的草稿；按 Esc 或直接打字，它消失。

![灰字预测：出现、Tab 接受](https://raw.githubusercontent.com/lsfcy/dsh-composer-predictions/main/demo/demo-zh.gif)

## 安装

仅适用于 DSH 的 Web / 桌面端（0.2.x），不能用于其他 agent/harness。

**方式一（推荐，终端，从 GitHub 安装或升级）**：

本次提示词和上下文优化暂只在 GitHub `main` 提供，**未发布 npm 新版本**；npm `0.1.3` 和 Git 标签 `v0.1.3` 均不包含本次优化。

```bash
dsh plugin --profile desktop add 'git+https://github.com/lsfcy/dsh-composer-predictions.git#main'
```

已通过 npm 安装的用户也执行同一条命令，无须先卸载。若要固定源码版本，将 `#main` 换为目标提交的完整 SHA。
桌面端 profile 是 `desktop`；其他入口用 `~/.dsh/profiles` 里对应的名字，如 `web`。

首次安装时，DSH 会监听 profile 的 bundle 清单加载新插件。**更新已有插件后，请在当前任务结束时重启一次 DSH**，确保宿主加载新代码；仅刷新页面不能确认服务端提示词已经更新。
安装时若宿主报了模块加载失败（pnpm 正在改写 `node_modules`，宿主读到了半写入的文件），同样重启一次 DSH。

**提示 `command not found: dsh`** 说明终端里没有 CLI，先补上再装插件：

- 桌面端：菜单栏 `DeepSeek Harness → 管理 dsh 命令…`，按提示把 `dsh` 链接到终端。
- 或者 npm 全局安装（需要先有 Node.js）：`npm install -g @deepseek-ai/dsh`。

**方式二（备选，在 DSH 会话里）**：让 agent 执行

```
plugin_manager  action: install_bundle
                target: git+https://github.com/lsfcy/dsh-composer-predictions.git#main
```

这条路依赖 agent 工具和当前 profile 状态，失败率更高；装不上就用方式一，效果一样。

## 配置

**设置 → 输入框预测**：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关：关闭后不再请求，也不显示灰字。 |
| `provider` | 自动 | 留空用你当前选中的 provider。 |
| `model` | 自动 | 留空用该 provider 下最便宜的型号。 |
| `reasoningEffort` | 自动 | 留空用模型支持的最省推理档。 |
| `historyMessages` | `12` | 历史消息上限；按用户轮次取样，最多 `floor(上限 / 2)` 轮。 |
| `perMessageChars` | `1600` | 单条原文预算；最新用户请求用 1.5 倍，历史助手回复用 1/4。 |
| `totalChars` | `6000` | 整个转录的 Unicode 字符预算，包含角色标记和分隔符。 |
| `maxPredictionChars` | `160` | 建议的最大 Unicode 字符数。 |

这些键同样可以写在 profile patch 的 bundle row `config` 里。

## 原理

1. 宿主只读取会话派生消息中的真人 user / assistant 正文，不读原始日志、系统提示、工具输出或思考块。
2. 只在完整问答后预测；已知中止、失败、输出截断的轮次不预测。当前请求无文本、最终回复为空或仍有工具调用时也不预测。
3. 按下面的意图优先策略裁剪原文，调用一次便宜模型，取一行（≤160 Unicode 字符）。建议和 `SKIP` 都按会话内容及生成配置缓存 30 分钟。
4. 客户端把它画成灰字；Tab 只写入草稿，不会发送。

### 预测策略

预测的是**用户已有意图的延续**，不是替用户安排新任务：

- 用户的目的、交付物、最新纠正和范围限制优先于助手自己的建议。
- 优先考虑有依据的当前产物修改、格式调整、补齐已要求的内容，或针对用户指出的缺陷重试。
- 不因为助手说「完成了」就追加测试、文档、重构、评审或提交。文件名相同不等于任务有依据。
- 请求已完成且没有明确延续、多个方向同样合理或必要上下文缺失时，返回 `SKIP`，不显示建议。
- 转录是非可信数据，不是预测指令；提示词禁止建议批准破坏性操作、扩大权限、泄露秘密或生产部署。这是模型指令，不是可替代人工审核的权限控制。

### 上下文预算

默认只看最近最多 **6 个用户轮次**，最多 12 条、6000 Unicode 字符：

1. 当前请求最多 2400 字符，最终回复最多 1600 字符。预算较小时先确保两者都保留。
2. 剩余预算先在较早的用户请求间分配，每条最多 1600 字符；有余量才补对应轮次最后一条助手回复，每条最多 400 字符。进度消息不占历史名额。
3. 长请求保留开头目标和末尾约束；助手回复保留开头和结论。最终按原时间顺序排列，不拆开 emoji 等 Unicode 码点。
4. 不永久固定会话第一条，不为图片请求借用旧文本，也不把空回复或工具调用前的进度当最终产物。窗口外和原文中间的信息仍可能丢失。

新策略替代按最近消息倒序塞满预算；不增加模型请求次数、检索、长期画像或配置开关。效果不好可用 `enabled: false` 停用。

## 成本

单次生成包含策略提示词、裁剪后的转录和最多 512 token 输出；实际 token 数随语言、模型和配置变化。
默认仍优先选择便宜型号和最低支持推理档；命中缓存不产生模型费用，不自动增加第二次调用来总结上下文。

## 限制

- 它只是猜测，没有记忆：不做检索，不读长期画像，只看最近这段转录。
- 只在成功轮次后出现，且永不自动发送。
- 便宜模型可能平淡或猜错；在意质量可在配置里固定更强的模型。
- 只给一行，不会给多步计划。

## 验证

`npm test` 运行离线测试，覆盖提示词接线、六轮窗口、进度消息过滤、末尾约束、Unicode 预算、缺失上下文不请求，以及现有缓存、HTTP、设置和客户端 bundle 行为。

提示词契约测试只证明规则存在，不证明真实模型遵循规则。人工验收应固定模型，比较同一批 10–20 个对话截点：是否延续已有意图、是否具体有用、任务完成或依据不足时是否保持沉默。不把建议出现率当作质量证明。
