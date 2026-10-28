# dsh-composer-predictions

[![CI](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml/badge.svg)](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml)

Dim next-message suggestions in the DeepSeek Harness composer after a turn settles.
**Tab** accepts the suggestion into the draft; **Esc** or typing dismisses it. Nothing is sent.

English | [中文](README.md) · [Live demo](https://lsfcy.github.io/dsh-composer-predictions/demo/dsh.html?lang=en)

## Example

The assistant finishes with "All 12 tests pass." The empty composer then shows, dimmed:

> Want me to commit this change? I can write the message.

Press Tab and it becomes an editable draft. Press Esc, or start typing, and it disappears.

![Composer prediction: ghost appears, Tab accepts](https://raw.githubusercontent.com/lsfcy/dsh-composer-predictions/main/demo/demo-en.gif)

## Install

DSH Web / desktop only (0.2.x). It does not work in other agents or harnesses.

**Option 1 (recommended, inside a DSH session)**: ask the agent to run

```
plugin_manager  action: install_bundle
                target: @lsfcy/dsh-composer-predictions
```

It applies without a restart (refresh the page if the UI does not update).

**Option 2 (terminal)**:

```bash
dsh plugin --profile desktop add @lsfcy/dsh-composer-predictions
```

Restart DSH afterwards. The desktop app uses `desktop`; other entrypoints use their profile under `~/.dsh/profiles`, e.g. `web`. To pin a version without npm:
`dsh plugin --profile desktop add git+https://github.com/lsfcy/dsh-composer-predictions.git#v0.1.2`.

## Config

**Settings → 输入框预测 / Composer prediction**:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch: off stops requests and hides the ghost. |
| `provider` | auto | Empty uses the provider you are currently using. |
| `model` | auto | Empty uses the cheapest model on that provider. |
| `reasoningEffort` | auto | Empty uses the cheapest effort the model supports. |

The same keys work as the bundle row's `config` in a profile patch.

## How it works

1. The host reads the session's real user/assistant messages, keeps the last 12, and clips them to 6,000 characters.
2. It only predicts after a completed turn that ended on an assistant reply.
3. One cheap model call returns a single line (≤160 characters), cached per session content for 30 minutes.
4. The client paints it as ghost text; Tab writes it into the draft.

## Cost

One generation uses roughly 2–3k tokens (system prompt + transcript + output capped at 512) on the cheapest model at the lowest reasoning effort. Cache hits are free, and aborted turns never call the model.

## Limits

- It is a guess, not memory: no retrieval, no long-term profile, no knowledge beyond the recent transcript.
- Only after successful turns; a suggestion never sends itself.
- Cheap models can be bland or wrong. Pin a stronger model in Config if you care more about quality.
- One line only, no multi-step plans.
