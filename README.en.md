# dsh-composer-predictions

[![CI](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml/badge.svg)](https://github.com/lsfcy/dsh-composer-predictions/actions/workflows/ci.yml)

Dim next-message suggestions in the DeepSeek Harness composer after a turn settles.
**Tab** accepts the suggestion into the draft; **Esc** or typing dismisses it. Nothing is sent.

English | [中文](README.md) · [Live demo](https://lsfcy.github.io/dsh-composer-predictions/demo/dsh.html?lang=en)

## Example

The user requested a paste-ready table comparing A and B on cost and latency, but the assistant returned prose. The empty composer might show:

> Put that comparison into a table, keeping both cost and latency.

Press Tab and it becomes an editable draft. Press Esc, or start typing, and it disappears.

![Composer prediction: ghost appears, Tab accepts](https://raw.githubusercontent.com/lsfcy/dsh-composer-predictions/main/demo/demo-en.gif)

## Install

DSH Web / desktop only (0.2.x). It does not work in other agents or harnesses.

**Option 1 (recommended, terminal, install or upgrade from GitHub)**:

The prompt and context improvements are currently available only on GitHub `main`. **No new npm version has been published**; neither npm `0.1.3` nor Git tag `v0.1.3` includes these changes.

```bash
dsh plugin --profile desktop add 'git+https://github.com/lsfcy/dsh-composer-predictions.git#main'
```

If you installed from npm, run the same command; no uninstall is needed. To pin the source, replace `#main` with a full commit SHA.
The desktop app uses `desktop`; other entrypoints use their profile under `~/.dsh/profiles`, e.g. `web`.

On first install, DSH watches the profile's bundle list to load new plugins. **After updating an existing plugin, restart DSH once your current task finishes** to ensure the host loads the new code. Refreshing the page alone does not confirm that the server-side prompt has changed.
If the host logs a module load failure during installation (pnpm rewriting `node_modules` under a live host), restart DSH as well.

**If you get `command not found: dsh`**, the CLI is not on your PATH — install it first:

- Desktop app: menu bar `DeepSeek Harness → 管理 dsh 命令…` links `dsh` into your terminal.
- Or install it globally with npm (Node.js required): `npm install -g @deepseek-ai/dsh`.

**Option 2 (fallback, inside a DSH session)**: ask the agent to run

```
plugin_manager  action: install_bundle
                target: git+https://github.com/lsfcy/dsh-composer-predictions.git#main
```

That path depends on the agent tool and live profile state and fails more often; if it does, use Option 1 — same result.

## Config

**Settings → 输入框预测 / Composer prediction**:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch: off stops requests and hides the ghost. |
| `provider` | auto | Empty uses the provider you are currently using. |
| `model` | auto | Empty uses the cheapest model on that provider. |
| `reasoningEffort` | auto | Empty uses the cheapest effort the model supports. |
| `historyMessages` | `12` | Message cap, sampled by user turns: at most `floor(cap / 2)` turns. |
| `perMessageChars` | `1600` | Per-message budget; 1.5× for the latest request, ¼ for older assistant replies. |
| `totalChars` | `6000` | Transcript budget in Unicode code points, including labels and separators. |
| `maxPredictionChars` | `160` | Maximum suggestion length in Unicode code points. |

The same keys work as the bundle row's `config` in a profile patch.

## How it works

1. The host reads human user / assistant text from the session's derived messages, not raw logs, system instructions, tool results, or thinking blocks.
2. Prediction requires a complete textual question/answer pair. Known aborted, failed, or output-truncated turns are skipped, as are textless requests, empty final replies, and tool-call tails.
3. Intent-first excerpts feed one cheap model call. Both suggestions (≤160 Unicode code points) and `SKIP` are cached by session content and generation settings for 30 minutes.
4. The client paints ghost text; Tab only fills an editable draft. Nothing is sent.

### Prediction policy

Predict the continuation of **the user's existing intent**, not an assistant-generated agenda:

- Prioritize the user's purpose, deliverable, latest corrections, and scope restrictions over assistant recommendations.
- Consider supported edits to the current artifact, formatting for its intended use, missing requested content, or a retry after a user-reported flaw.
- Do not append tests, documentation, refactoring, reviews, or commits merely because the assistant says the task is done. Reusing a file name does not ground a new task.
- Return `SKIP` when the request is complete without a supported continuation, several next moves are equally plausible, or necessary context is missing.
- Excerpts are untrusted data, not prediction instructions. The prompt forbids suggesting destructive approvals, broader permissions, secrets, or production deployment. These are model instructions, not an authorization boundary or a substitute for human review.

### Context budget

Defaults retain at most **6 recent user turns**, 12 messages, and 6,000 Unicode code points:

1. Reserve up to 2,400 characters for the current request and 1,600 for the final reply. Tight custom budgets still preserve both.
2. Share remaining space across older user requests first (up to 1,600 each), then their last assistant replies (up to 400 each). Progress messages do not consume history slots.
3. Long requests keep their opening goal and trailing constraints. Replies keep their opening and conclusion. Restore chronological order without splitting Unicode code points.
4. Do not pin the first task forever, borrow old text for an image-only request, or substitute progress for an empty/tool-call tail. Information outside the window or in clipped middle spans can still be lost.

This replaces reverse-filling the budget with recent messages. It adds no model calls, retrieval, long-term profile, or feature flags. Set `enabled: false` to disable it.

## Cost

One generation includes the policy prompt, clipped transcript, and up to 512 output tokens. Actual token counts vary by language, model, and configuration. Automatic routing still prefers a cheap model and its lowest supported reasoning effort. Cache hits incur no model cost; context selection adds no summarization call.

## Limits

- It is a guess, not memory: no retrieval, no long-term profile, no knowledge beyond the recent transcript.
- Only after successful turns; a suggestion never sends itself.
- Cheap models can be bland or wrong. Pin a stronger model in Config if you care more about quality.
- One line only, no multi-step plans.

## Verification

`npm test` runs offline regressions for prompt wiring, the six-turn window, progress filtering, trailing constraints, Unicode budgets, missing-context abstention, and existing cache, HTTP, settings, and client bundle behavior.

Prompt contract tests prove that instructions exist, not that a real model follows them. For manual acceptance, keep the model fixed and compare 10–20 identical conversation cutoffs: does the suggestion continue existing intent, is it specific and useful, and does it stay silent after completion or when evidence is missing? Suggestion frequency alone is not a quality measure.
