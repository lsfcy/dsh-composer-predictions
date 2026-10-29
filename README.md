# dsh-composer-predictions

[![CI](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml/badge.svg)](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml)

给 DeepSeek Harness 的输入框补上“下一句预测”：一轮对话结束后，在空的输入框里用灰字显示
你接下来可能发送的消息。**Tab** 填入草稿，**Esc** 或开始打字即忽略。不会自动发送。

[English](README.en.md) | 中文 · [在线试玩](https://lsfcy.github.io/dsh-composer-predictions/demo/dsh.html)

## 示例

助手刚说完「测试全部通过」，空输入框里出现灰字：

> 顺手把这次改动提交了吗？提交信息我一起写好

按 Tab，它变成可编辑的草稿；按 Esc 或直接打字，它消失。

![灰字预测：出现、Tab 接受](https://raw.githubusercontent.com/lsfcy/dsh-composer-predictions/main/demo/demo-zh.gif)

## 安装

仅适用于 DSH 的 Web / 桌面端（0.2.x），不能用于其他 agent/harness。

**方式一（推荐，终端）**：

```bash
dsh plugin --profile desktop add @lsfcy/dsh-composer-predictions
```

装完**不用重启**：运行中的 DSH 会监听 profile 的 bundle 清单，装好即加载，已经打开的页面也会直接挂上新插件。桌面端 profile 是 `desktop`；
其他入口用 `~/.dsh/profiles` 里对应的名字，如 `web`。不想走 npm 时，也可以用固定版本：
`dsh plugin --profile desktop add git+https://github.com/lsfcy/dsh-composer-predictions.git#v0.1.3`。

灰字一直不出现就刷新一次页面；万一安装时宿主报了模块加载失败（pnpm 正在改写 `node_modules`，宿主读到了半写入的文件），重启一次 DSH 即可。

**提示 `command not found: dsh`** 说明终端里没有 CLI，先补上再装插件：

- 桌面端：菜单栏 `DeepSeek Harness → 管理 dsh 命令…`，按提示把 `dsh` 链接到终端。
- 或者 npm 全局安装（需要先有 Node.js）：`npm install -g @deepseek-ai/dsh`。

**方式二（备选，在 DSH 会话里）**：让 agent 执行

```
plugin_manager  action: install_bundle
                target: @lsfcy/dsh-composer-predictions
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

这些键同样可以写在 profile patch 的 bundle row `config` 里。

## 原理

1. 宿主读取会话里真人的 user/assistant 消息，只取最近 12 条，压到 6000 字符。
2. 只在一轮**成功结束**、且最后一条是 assistant 回复时预测。
3. 调一次便宜模型，取一行（≤160 字符），按会话内容缓存 30 分钟。
4. 客户端把它画成灰字；Tab 写入输入框。

## 成本

单次生成约 2–3k token（system 提示词 + 转录 + 输出上限 512），走最便宜型号和最低推理档。
命中缓存不产生费用；被中止的轮次不会调用模型。

## 限制

- 它只是猜测，没有记忆：不做检索，不读长期画像，只看最近这段转录。
- 只在成功轮次后出现，且永不自动发送。
- 便宜模型可能平淡或猜错；在意质量可在配置里固定更强的模型。
- 只给一行，不会给多步计划。
