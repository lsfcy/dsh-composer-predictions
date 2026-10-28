// Host half of the composer-predictions plugin.
//
// It owns exactly one thing: POST /composer-predictions/predict, a loopback
// route the browser half calls after a turn settles. The route reads the
// session's own derived messages, asks the configured model for ONE plausible
// next user message, and answers { text }. Nothing is written to the session
// log — a prediction is not history, it is a hint, so it must never enter the
// context the agent sees.
//
// Two details are easy to get wrong and are handled here instead of in the UI:
//
//   * A session transcript contains synthetic `user` messages (runtime context,
//     skill catalogue, plan/PTC mode, subagent notices). Only messages the human
//     actually sent may feed a prediction, otherwise the model reads a wall of
//     harness boilerplate and predicts harness instructions.
//   * The selected model may be a reasoning model. Predictions are a tiny,
//     latency-sensitive call, so the host asks the adapter for the cheapest
//     supported reasoning effort ("off" when it exists) and prefers a cheap
//     model on the user's provider.
//
// Loaded by the bundle row in cordis.patch.yml.

import z from '@deepseek-ai/schemastery'

export const name = 'composer-predictions'
export const GENERATOR_VERSION = '0.1.2'
// webServer: the route; sessions: the transcript; llm: the model call.
export const inject = ['webServer', 'sessions', 'llm']

const PREDICT_PATH = '/composer-predictions/predict'
const CONFIG_PATH = '/composer-predictions/config'
const OPTIONS_PATH = '/composer-predictions/options'
const BODY_LIMIT_BYTES = 8 * 1024

const CHEAP_MODEL = /\b(flash|mini|small|lite|fast|haiku|nano)\b/i
const EFFORT_PREFERENCE = ['off', 'none', 'minimal', 'low']

// Codex keeps the suggestion with the thread, so switching threads shows the
// suggestion that thread already earned instead of an empty composer. Mirror
// that: one entry per session, valid only while the session's last seq is the
// one the suggestion was generated from. In memory only — a hint is not
// history, and restarting the process should not resurrect a stale line.
const CACHE_LIMIT = 40
const CACHE_TTL_MS = 30 * 60 * 1000
const predictionCache = new Map()

export const DEFAULTS = Object.freeze({
  // Master switch. false stops every request and hides the ghost.
  enabled: true,
  // Reasoning models spend these tokens before any text exists; below ~256 the
  // answer is often an empty string even though the call "succeeded".
  maxTokens: 512,
  historyMessages: 12,
  timeoutMs: 20_000,
  perMessageChars: 1_600,
  totalChars: 6_000,
  maxPredictionChars: 160,
})

const SYSTEM_PROMPT = [
  'You suggest the next message a developer will type in a coding-assistant chat.',
  '',
  "The excerpt ends with the assistant's last reply. Predict the one message the user is most likely to send next, as if they were typing it themselves.",
  '',
  'Rules:',
  "- Write in the user's language and register, with a similar amount of detail.",
  '- Be concrete: reuse the file names, functions, commands, error text, or numbers that appear in the excerpt.',
  "- Write the user's own request or question. Never reply as the assistant, never mention predicting, and never add commentary about the request.",
  "- Ground every claim in the context. Do not invent that the user has already observed a result, approved or sent anything, or that a fix is confirmed: an assistant's claim is not proof the user accepted it.",
  '- A suggestion is one message, not an agenda: respond to what just happened or continue the task naturally. Do not append extra next steps the user never asked for.',
  '- One line of plain text. Stay under roughly 60 characters for Chinese, Japanese, or Korean, and 120 characters otherwise.',
  '- No greeting, no preamble, no quotes, no markdown, no trailing ellipsis.',
  '- If no concrete next message is supported by the excerpt, output exactly: SKIP',
].join('\n')

const PROMPT_HEADER = 'Conversation excerpt (oldest first):\n\n'
const PROMPT_FOOTER = "\n\nWrite the user's next message."

/** Concatenate the text blocks of one message; non-text blocks are ignored. */
export function textOf(message) {
  const content = message && message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Whether one `user`-role message was actually written by the human.
 *
 * `Session.deriveMessages()` replays every synthetic prompt input as a
 * user-role message: runtime context, agent instructions, the skill catalogue,
 * plan/PTC mode notices, time context, and subagent relays all carry their own
 * `source.kind`. Only `kind: 'user'` (or a hand-built message with no source,
 * which is what tests use) is the user's own voice.
 */
export function isUserAuthored(message) {
  if (!message || message.role !== 'user') return false
  const source = message.source
  if (source === undefined || source === null) return true
  return source.kind === 'user'
}

/** Keep only the messages a prediction should read, oldest first. */
function conversationMessages(messages) {
  const rows = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message && message.role
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'user' && !isUserAuthored(message)) continue
    const text = textOf(message)
    if (!text) continue
    rows.push({ role, text })
  }
  return rows
}

/**
 * One message clipped to at most `limit` characters.
 *
 * A long assistant reply carries its conclusion at the END ("fixed", "tests
 * pass", "press Cmd+R"). Head-only clipping used to hide exactly that part and
 * leave the model mid-debugging, so it kept predicting another bug report, so
 * assistant text keeps both ends. User requests keep their head. The result
 * never exceeds `limit`: the ellipsis is counted inside the budget.
 */
function clipMessage(text, limit, role) {
  const max = Math.floor(Math.max(0, Number(limit)))
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (role !== 'assistant') {
    return max <= 1 ? text.slice(0, max) : text.slice(0, max - 1) + '…'
  }
  const sep = ' … '
  if (max <= sep.length) return text.slice(0, max)
  const head = Math.max(0, Math.round(max * 0.35))
  const tail = max - head - sep.length
  return tail > 0
    ? text.slice(0, head) + sep + text.slice(text.length - tail)
    : text.slice(0, max)
}

/**
 * Render the model-visible history as a plain transcript, newest last.
 *
 * The current turn — the last user request and the assistant reply that just
 * answered it — is mandatory and budgeted first: a prediction without the
 * request that earned the reply, or without the reply's conclusion, is noise.
 * Older context only uses leftover budget. The newest assistant reply gets a
 * larger per-message budget than the rest.
 */
export function buildTranscript(messages, options = {}) {
  const limit = options.historyMessages ?? DEFAULTS.historyMessages
  const perMessage = options.perMessageChars ?? DEFAULTS.perMessageChars
  const total = options.totalChars ?? DEFAULTS.totalChars
  const rows = conversationMessages(messages)
  if (rows.length === 0) return ''

  const label = (role) => (role === 'user' ? 'User: ' : 'Assistant: ')
  const line = (role, body) => label(role) + body

  // Locate the current turn: it begins at the last user-authored message.
  let lastUser = -1
  for (let index = rows.length - 1; index >= 0 && lastUser === -1; index -= 1) {
    if (rows[index].role === 'user') lastUser = index
  }
  const newestAssistant = rows[rows.length - 1].role === 'assistant'
  const paired = newestAssistant && lastUser >= 0 && lastUser < rows.length - 1

  // --- paired path: reserve budget for [last user, newest assistant] ---
  if (paired) {
    const userRow = rows[lastUser]
    const assistantRow = rows[rows.length - 1]
    const overhead = label('user').length + label('assistant').length + 2 // '\n\n'
    let assistantBudget = Math.round(perMessage * 1.5)
    let userBudget = perMessage
    const available = total - overhead
    // Shrink both bodies until they fit, keeping them proportional.
    const want = assistantBudget + userBudget
    if (want > available) {
      const factor = available / want
      assistantBudget = Math.max(0, Math.floor(assistantBudget * factor))
      userBudget = Math.max(0, Math.floor(userBudget * factor))
    }
    const pairText = line('user', clipMessage(userRow.text, userBudget, 'user')) +
      '\n\n' +
      line('assistant', clipMessage(assistantRow.text, assistantBudget, 'assistant'))

    // Older context, newest first, within the leftover budget after the pair.
    const olderPieces = []
    let olderUsed = 2 // the '\n\n' that would join older text to the pair
    for (let index = lastUser - 1; index >= 0; index -= 1) {
      const row = rows[index]
      const room = total - pairText.length - olderUsed - label(row.role).length
      if (room < 1) break
      olderPieces.push(line(row.role, clipMessage(row.text, Math.min(room, perMessage), row.role)))
      olderUsed += olderPieces[olderPieces.length - 1].length + 2
      if (olderPieces.length >= Math.max(0, limit - 2)) break
    }
    olderPieces.reverse()
    const olderText = olderPieces.join('\n\n')
    return olderText ? olderText + '\n\n' + pairText : pairText
  }

  // --- uniform path: no user/assistant pairing to preserve ---
  const selected = rows.slice(-Math.max(1, limit))
  const pieces = []
  let used = 0
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const row = selected[index]
    const room = total - used - (pieces.length ? 2 : 0) - label(row.role).length
    if (room < 1 && pieces.length) break
    pieces.push(line(row.role, clipMessage(row.text, Math.min(Math.max(0, room), perMessage), row.role)))
    used += pieces[pieces.length - 1].length + (pieces.length > 1 ? 2 : 0)
    if (used >= total) break
  }
  pieces.reverse()
  return pieces.join('\n\n')
}

/**
 * The role of the newest message a human would recognise. Used to refuse a
 * prediction when the turn did not actually end on an assistant reply (an
 * aborted turn, a queued message, or a failed request).
 */
export function lastConversationRole(messages) {
  const rows = conversationMessages(messages)
  return rows.length > 0 ? rows[rows.length - 1].role : undefined
}

/** One display line, or '' when the model declined (SKIP) or said nothing usable. */
export function normalizePrediction(raw, maxLength = DEFAULTS.maxPredictionChars) {
  const limit = Number.isFinite(Number(maxLength)) ? Math.max(40, Math.round(Number(maxLength))) : DEFAULTS.maxPredictionChars
  let text = String(raw == null ? '' : raw).replace(/\r/g, '').trim()
  if (!text || /^skip\b/i.test(text)) return ''
  // A small model occasionally wraps the line in a code fence or a label.
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') || ''
  const line = firstLine
    .replace(/^[-*•]\s+/, '')
    .replace(/^(?:user|用户)\s*[:：]\s*/i, '')
    .replace(/^(?:suggestion|prediction|next message|建议|预测)\s*[:：]\s*/i, '')
    .replace(/^[`"'“”「」『』]+/, '')
    .replace(/[`"'“”「」『』]+$/, '')
    .trim()
  if (!line || /^skip\b/i.test(line)) return ''
  // The model sometimes answers as the assistant ("Sure, I've updated…") instead
  // of writing the user's own message. Borrowed from the sibling npm plugin's
  // output guard: reject English assistant openers, keep Chinese ones (a user
  // legitimately starts with "好的/已…").
  if (/^(?:sure|certainly|of course|absolutely|done|here(?:'s| is| are)|i(?:'ve| have)? (?:updated|fixed|added|changed|created|removed|refactored))\b/i.test(line)) {
    return ''
  }
  if (line.length <= limit) return line
  return line.slice(0, limit).replace(/[\s,，、;；:：.。]+$/, '')
}

/**
 * The model the user already selected for this app, when that service is
 * mounted (`ctx.get` is the optional-service convention: absent service, no
 * throw). A prediction should sound like the agent the user is talking to.
 */
export function defaultSelection(ctx) {
  const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  if (!service || typeof service.currentSelection !== 'function') return undefined
  try {
    const selection = service.currentSelection()
    if (!selection || !selection.provider || !selection.model) return undefined
    return { provider: String(selection.provider), model: String(selection.model) }
  } catch {
    return undefined
  }
}

/**
 * Pick the model route. Explicit config wins. Otherwise stay on the user's
 * provider but prefer a cheap model there: a prediction is a latency-sensitive
 * side call, not a coding turn. The user's own model is kept when it is already
 * a cheap one, and is the fallback when discovery names no cheap sibling.
 */
export async function resolveRoute(llm, config = {}, signal) {
  const providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const offered = (Array.isArray(providers) ? providers : [])
    .map((provider) => (provider && provider.id ? String(provider.id) : ''))
    .filter(Boolean)
  const provider = config.provider ? String(config.provider) : offered[0]
  if (!provider) throw new Error('no LLM provider is registered')
  if (config.model) return { provider, model: String(config.model) }

  const preferred = config.preferredModel ? String(config.preferredModel) : ''
  let advertised = []
  try {
    const models = await llm.listModels(provider, signal)
    advertised = (Array.isArray(models) ? models : [])
      .map((model) => (model && model.id != null ? String(model.id) : ''))
      .filter(Boolean)
  } catch (error) {
    // Per-request discovery can fail on providers that only list models at
    // configuration time; the user's own selection is still a valid route.
    if (preferred) return { provider, model: preferred }
    throw error
  }
  const named = advertised.includes(preferred) ? preferred : undefined
  const model =
    (named && CHEAP_MODEL.test(named) ? named : undefined) ||
    advertised.find((id) => CHEAP_MODEL.test(id)) ||
    named ||
    advertised[0]
  if (!model) throw new Error(`provider "${provider}" advertises no models`)
  return { provider, model }
}

/**
 * The cheapest reasoning effort the adapter supports, or undefined when the
 * model does not reason (or cannot be inspected). Explicit config always wins.
 */
async function supportedEfforts(llm, route, signal) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
  let info
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, signal)
  } catch {
    return undefined
  }
  const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : []
  return efforts
    .map((effort) => (effort && effort.id != null ? String(effort.id) : ''))
    .filter(Boolean)
}

/** The cheapest effort the model advertises, when the adapter can tell us. */
export async function resolveEffort(llm, route, signal) {
  const ids = await supportedEfforts(llm, route, signal)
  if (!ids) return undefined
  for (const candidate of EFFORT_PREFERENCE) {
    if (ids.includes(candidate)) return candidate
  }
  return undefined
}

/**
 * A pinned effort is only used when the model advertises it. Otherwise the
 * prediction falls back to the cheapest supported effort: an explicit but
 * unsupported id makes the provider reject the whole call
 * (UNSUPPORTED_REASONING_EFFORT) and the composer would show nothing.
 */
export async function chooseEffort(llm, route, signal, requested) {
  const ids = await supportedEfforts(llm, route, signal)
  if (!ids) return undefined
  if (requested && ids.includes(requested)) return requested
  for (const candidate of EFFORT_PREFERENCE) {
    if (ids.includes(candidate)) return candidate
  }
  return undefined
}

/** Row config is user-edited YAML: clamp it instead of trusting it. */
export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const integer = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }
  const string = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  return {
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled !== false,
    provider: string(raw.provider),
    model: string(raw.model),
    reasoningEffort: string(raw.reasoningEffort),
    maxTokens: integer(raw.maxTokens, DEFAULTS.maxTokens, 64, 4_096),
    historyMessages: integer(raw.historyMessages, DEFAULTS.historyMessages, 2, 50),
    timeoutMs: integer(raw.timeoutMs, DEFAULTS.timeoutMs, 1_000, 120_000),
    perMessageChars: integer(raw.perMessageChars, DEFAULTS.perMessageChars, 200, 8_000),
    totalChars: integer(raw.totalChars, DEFAULTS.totalChars, 1_000, 40_000),
    maxPredictionChars: integer(raw.maxPredictionChars, DEFAULTS.maxPredictionChars, 40, 500),
  }
}

/**
 * A stable fingerprint of the message surface. `session.seq` cannot serve:
 * persistence receipts (for example `session-log-deepseek/delivery-accepted`) are appended to the
 * same log after every flush and bump it continuously. Surface nodes change
 * only when a message is actually appended or replaced.
 */
export function sessionTail(session) {
  const surface = session && session.surface
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : []
  return nodes.length > 0 ? Number(nodes[nodes.length - 1]) : 0
}

/** Read a cached suggestion only when it still matches the session's input. */
function cachedPrediction(session, fingerprint) {
  const key = String(session.id)
  const entry = predictionCache.get(key)
  if (!entry) return undefined
  if (entry.fingerprint !== fingerprint || Date.now() - entry.at > CACHE_TTL_MS) {
    predictionCache.delete(key)
    return undefined
  }
  return entry
}

function rememberPrediction(session, fingerprint, payload) {
  const key = String(session.id)
  predictionCache.delete(key)
  predictionCache.set(key, { fingerprint, payload, at: Date.now() })
  while (predictionCache.size > CACHE_LIMIT) {
    const oldest = predictionCache.keys().next().value
    predictionCache.delete(oldest)
  }
}

/**
 * Deterministic fingerprint of everything that changes the generated line: the
 * transcript itself, the generator version, and the config knobs that affect
 * output. Reusing a suggestion across a changed transcript, model, or budget
 * would show a stale line, so the cache key cannot be the session's seq alone.
 */
function predictionFingerprint(config, transcript) {
  const effectors = {
    provider: config.provider ?? '',
    model: config.model ?? '',
    reasoningEffort: config.reasoningEffort ?? '',
    maxTokens: config.maxTokens,
    maxPredictionChars: config.maxPredictionChars,
    historyMessages: config.historyMessages,
    perMessageChars: config.perMessageChars,
    totalChars: config.totalChars,
  }
  return hashString(GENERATOR_VERSION + '|' + transcript + '|' + JSON.stringify(effectors))
}

function hashString(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Test seam: the cache must never leak across cases. */
export function clearPredictionCache() {
  predictionCache.clear()
}

/**
 * Declared schema so the Loader validates the row config and the settings UI
 * can edit it as a form. Every knob is optional: absent fields fall back to
 * the defaults above (and the host's cheapest-model pick when provider/model
 * are unset).
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('总开关：关闭后不再请求或显示预测。'),
  provider: z.string().role('text').description('模型 provider；默认用用户当前选中的 provider。'),
  model: z.string().role('text').description('模型 id；默认用同 provider 下最便宜的型号，没有便宜型号则退回当前选中模型。'),
  reasoningEffort: z.string().role('text').description('推理档；默认自动选 off > none > minimal > low。'),
  maxTokens: z.number().role('slider').min(64).max(4096).step(64).default(DEFAULTS.maxTokens).description('一次预测的输出上限；推理模型会把预算先花在思考上，太小会返回空。'),
  historyMessages: z.number().role('slider').min(2).max(50).step(1).default(DEFAULTS.historyMessages).description('喂给模型的历史消息条数（只含真人 user + assistant 文本）。'),
  timeoutMs: z.number().role('slider').min(1000).max(120000).step(1000).default(DEFAULTS.timeoutMs).description('单次预测的最长等待时间。'),
  perMessageChars: z.number().role('slider').min(200).max(8000).step(100).default(DEFAULTS.perMessageChars).description('单条消息截断上限（最新一条 assistant 用 1.5 倍）。'),
  totalChars: z.number().role('slider').min(1000).max(40000).step(500).default(DEFAULTS.totalChars).description('整个转录的字符预算。'),
  maxPredictionChars: z.number().role('slider').min(40).max(500).step(20).default(DEFAULTS.maxPredictionChars).description('建议的最大显示/接受长度。'),
})

/**
 * The reason of the newest `turn/end`, read by walking back from the session
 * tail. `eventAt` is the cheap public accessor; `snapshotEvents` is the
 * fallback for hosts that expose only the bulk reader.
 */
export function lastTurnOutcome(session) {
  if (!session) return undefined
  const seq = Number(session.seq)
  if (!Number.isFinite(seq)) return undefined
  if (typeof session.eventAt === 'function') {
    for (let offset = 1; offset <= 64 && seq - offset >= 0; offset += 1) {
      let event
      try {
        event = session.eventAt(seq - offset)
      } catch {
        return undefined
      }
      if (event && event.type === 'turn/end') return event.data && event.data.reason
    }
    return undefined
  }
  if (typeof session.snapshotEvents !== 'function') return undefined
  let events
  try {
    events = session.snapshotEvents(Math.max(0, seq - 64))
  } catch {
    return undefined
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'turn/end') return event.data && event.data.reason
  }
  return undefined
}

/**
 * Codex only suggests a continuation after a SUCCESSFUL turn. The newest
 * assistant text alone cannot tell an abort from a completion (an aborted turn
 * can still leave partial text), so read the last `turn/end` reason. Unknown
 * shapes allow the prediction rather than silently disabling the feature on an
 * event-format change.
 */
export function lastTurnCompleted(session) {
  const reason = lastTurnOutcome(session)
  if (!reason || !reason.kind) return true
  return reason.kind === 'completed' || reason.kind === 'max-tokens'
}

/**
 * One prediction: transcript in, one line out. Split from the HTTP handler so
 * the prompt, route selection, and stream handling stay testable.
 */
export async function predict(ctx, config, sessionId, signal) {
  if (config && config.enabled === false) return { text: '', reason: 'disabled' }
  const session =
    ctx && ctx.sessions && typeof ctx.sessions.get === 'function' &&
    (typeof sessionId === 'string' || typeof sessionId === 'number')
      ? ctx.sessions.get(sessionId)
      : undefined
  if (!session || typeof session.deriveMessages !== 'function') {
    throw Object.assign(new Error('unknown session'), { status: 404 })
  }
  if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { status: 499 })

  // Eligibility is checked before anything is cached: a suggestion belongs to
  // a successful, settled turn, so a cache entry must never survive the turn
  // becoming aborted or the assistant reply vanishing.
  if (!lastTurnCompleted(session)) return { text: '', reason: 'turn-not-completed' }

  const messages = session.deriveMessages()
  // The turn must have ended on the assistant's reply. A queued submission or
  // an aborted turn leaves a user message last, and there is nothing sensible
  // to predict in that state.
  if (lastConversationRole(messages) !== 'assistant') return { text: '', reason: 'last-message-not-assistant' }
  const transcript = buildTranscript(messages, config)
  if (!transcript) return { text: '', reason: 'empty-transcript' }

  // Reuse a suggestion only when this exact transcript, generator version, and
  // output-affecting config generated it. Switching back to the session is
  // therefore a cache hit, while any message or config change regenerates.
  const fingerprint = predictionFingerprint(config, transcript)
  const cached = cachedPrediction(session, fingerprint)
  if (cached) return { ...cached.payload, cached: true }

  const generationTail = sessionTail(session)

  const selection = defaultSelection(ctx) || {}
  const route = await resolveRoute(
    ctx.llm,
    {
      provider: config.provider || selection.provider,
      model: config.model,
      preferredModel: selection.model,
    },
    signal,
  )
  const reasoningEffort = await chooseEffort(ctx.llm, route, signal, config.reasoningEffort)

  let raw = ''
  let finish
  for await (const chunk of ctx.llm.stream({
    ...route,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_HEADER + transcript + PROMPT_FOOTER }] }],
    system: SYSTEM_PROMPT,
    maxTokens: config.maxTokens,
    sessionId: session.id ?? sessionId,
    signal,
  })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure || {}
    throw new Error(`model call failed: ${failure.code || failure.message || finish.kind}`)
  }
  // The session may have moved on while the model was thinking (a queued
  // submission, a new turn). A prediction for the old tail must not be shown.
  if (sessionTail(session) !== generationTail) {
    return { text: '', reason: 'session-moved' }
  }

  const text = normalizePrediction(raw, config.maxPredictionChars)
  // A declined suggestion (SKIP) is remembered too, so switching back and forth
  // does not re-run the model on the same unchanged tail.
  const payload = {
    text,
    model: route.model,
    provider: route.provider,
    ...(reasoningEffort ? { effort: reasoningEffort } : {}),
    ...(text ? {} : { reason: 'model-empty' }),
    debug: {
      tail: generationTail,
      transcriptChars: transcript.length,
      rawChars: raw.length,
      finish: finish && finish.kind ? finish.kind : null,
    },
  }
  rememberPrediction(session, fingerprint, payload)
  return payload
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        fail(Object.assign(new Error('request body too large'), { status: 413 }))
        // Drain instead of destroying: the handler still owns a JSON reply.
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', fail)
  })
}

function send(response, status, payload) {
  if (response.writableEnded || response.destroyed) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * A browser page is the only intended caller. Browsers always send `Origin`
 * for a cross-origin POST (and a preflight for JSON), so rejecting a foreign
 * origin and a non-JSON body is enough to keep a random tab from spending the
 * user's model credentials.
 */
function requestAllowed(request) {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return false
    try {
      if (new URL(origin).host !== request.headers.host) return false
    } catch {
      return false
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const contentType = request.headers['content-type']
  if (typeof contentType === 'string' && contentType !== '' && !/^application\/json\b/i.test(contentType)) {
    return false
  }
  return true
}

/** Build the HTTP handler; exported so tests can drive a real server socket. */
export function createPredictHandler(ctx, config = {}) {
  // `config` is either a plain object (tests) or a getter owned by apply, so a
  // settings save can update the live values without re-registering the route.
  const getOptions = typeof config === 'function' ? config : () => normalizeConfig(config)
  return async function handle(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (!requestAllowed(request)) {
      send(response, 403, { error: 'forbidden' })
      return
    }

    const options = getOptions()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    // A page that navigates away (or a cancelled fetch) must not keep a model
    // call alive. A normally finished response is already writableEnded.
    response.on('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    try {
      const raw = await readBody(request)
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch (error) {
        throw Object.assign(new Error('invalid JSON body'), { status: 400, cause: error })
      }
      const prediction = await predict(ctx, options, body && body.sessionId, controller.signal)
      send(response, 200, prediction)
    } catch (error) {
      const status = error && error.status
        ? error.status
        : controller.signal.aborted
          ? 504
          : 500
      const message = error && error.message ? error.message : String(error)
      if (status >= 500 && ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[composer-predictions] predict failed: %s', message)
      }
      send(response, status, { error: message })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The public shape the settings page reads and writes. */
export function settingsView(options) {
  const config = options || {}
  return {
    enabled: config.enabled !== false,
    provider: config.provider ?? '',
    model: config.model ?? '',
    reasoningEffort: config.reasoningEffort ?? '',
    maxTokens: config.maxTokens,
    historyMessages: config.historyMessages,
    timeoutMs: config.timeoutMs,
    perMessageChars: config.perMessageChars,
    totalChars: config.totalChars,
    maxPredictionChars: config.maxPredictionChars,
  }
}

/** Untrusted page input: keep known keys and primitive types; clamp later. */
export function sanitizeSettings(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const out = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.provider === 'string') out.provider = raw.provider.trim().slice(0, 120)
  if (typeof raw.model === 'string') out.model = raw.model.trim().slice(0, 120)
  if (typeof raw.reasoningEffort === 'string') out.reasoningEffort = raw.reasoningEffort.trim().slice(0, 40)
  for (const key of ['maxTokens', 'historyMessages', 'timeoutMs', 'perMessageChars', 'totalChars', 'maxPredictionChars']) {
    if (raw[key] === undefined) continue
    const number = Number(raw[key])
    if (Number.isFinite(number)) out[key] = Math.round(number)
  }
  return out
}

/** A provider that cannot enumerate models must not hang the settings page. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The provider/model catalog the settings page offers. Kept off the predict
 * path: the dock asks for a suggestion on every mount and must stay fast.
 */
export async function collectOptions(ctx) {
  // No cache: a provider added in Settings → Models must appear on the next
  // open of this page, not after a TTL.
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  const listed = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const providers = (Array.isArray(listed) ? listed : [])
    .filter((provider) => provider && typeof provider.id === 'string')
    .map((provider) => ({ id: provider.id, name: typeof provider.name === 'string' ? provider.name : provider.id }))
  const models = []
  if (llm && typeof llm.listModels === 'function') {
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const list = await withTimeout(llm.listModels(provider.id), 3_000)
          for (const model of Array.isArray(list) ? list : []) {
            if (model && typeof model.id === 'string') {
              models.push({ provider: provider.id, id: model.id, name: typeof model.name === 'string' ? model.name : model.id })
            }
          }
        } catch {
          // A provider with no reachable catalog simply contributes no suggestions.
        }
      }),
    )
  }
  const selection = defaultSelection(ctx)
  const value = {
    providers,
    models,
    autoProvider: selection && typeof selection.provider === 'string' ? selection.provider : '',
  }
  return value
}

export function createOptionsHandler(ctx) {
  return async function handle(request, response) {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' }).end()
      return
    }
    if (!requestAllowed(request)) {
      send(response, 403, { error: 'forbidden' })
      return
    }
    try {
      send(response, 200, await collectOptions(ctx))
    } catch (error) {
      send(response, 500, { error: error && error.message ? error.message : String(error) })
    }
  }
}

/**
 * Settings endpoint. Writes go through the platform's configEditor, which
 * validates against the Config schema and persists the override in the
 * profile's patch — one source of truth, no plugin-owned JSON file.
 */
export function createConfigHandler(ctx, getOptions, setOptions) {
  return async function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' }).end()
      return
    }
    if (!requestAllowed(request)) {
      send(response, 403, { error: 'forbidden' })
      return
    }
    if (request.method === 'GET') {
      send(response, 200, { config: settingsView(getOptions()) })
      return
    }
    try {
      const raw = await readBody(request)
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch (error) {
        throw Object.assign(new Error('invalid JSON body'), { status: 400, cause: error })
      }
      const patch = sanitizeSettings(body && body.config !== undefined ? body.config : body)
      const editor = ctx && typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
      if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
        throw Object.assign(new Error('config editor is unavailable in this runtime'), { status: 501 })
      }
      const entry = editor.entries().find(
        (candidate) =>
          candidate &&
          candidate.options &&
          (candidate.options.id === 'composer-predictions' || candidate.options.name === '@lsfcy/dsh-composer-predictions'),
      )
      if (!entry) throw Object.assign(new Error('composer-predictions entry not found'), { status: 404 })
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      const next = normalizeConfig({ ...getOptions(), ...patch })
      setOptions(next)
      send(response, 200, { config: settingsView(next) })
    } catch (error) {
      const status = error && error.status ? error.status : 500
      const message = error && error.message ? error.message : String(error)
      if (status >= 500 && ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[composer-predictions] config failed: %s', message)
      }
      send(response, status, { error: message })
    }
  }
}

export function apply(ctx, config) {
  const state = { options: normalizeConfig(config) }
  const predictHandler = createPredictHandler(ctx, () => state.options)
  const configHandler = createConfigHandler(
    ctx,
    () => state.options,
    (next) => {
      state.options = next
    },
  )
  const optionsHandler = createOptionsHandler(ctx)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PREDICT_PATH, handler: predictHandler }),
    'composer-predictions: predict route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: configHandler }),
    'composer-predictions: config route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: OPTIONS_PATH, handler: optionsHandler }),
    'composer-predictions: options route',
  )
}
