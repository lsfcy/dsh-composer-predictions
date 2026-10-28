// Unit tests for the host half's pure logic plus end-to-end prediction runs
// against a fake llm/session: no DSH host, no network. Run with:
//   node --test test/
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTranscript,
  chooseEffort,
  clearPredictionCache,
  collectOptions,
  sanitizeSettings,
  settingsView,
  defaultSelection,
  isUserAuthored,
  lastConversationRole,
  lastTurnCompleted,
  normalizeConfig,
  normalizePrediction,
  predict,
  resolveEffort,
  resolveRoute,
  textOf,
} from '../index.js'

const user = (text, source = { kind: 'user' }) => ({
  role: 'user',
  source,
  content: [{ type: 'text', text }],
})
beforeEach(() => {
  clearPredictionCache()
})

const assistant = (text) => ({
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'text', text }],
})

test('textOf keeps only text blocks', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }] }), 'a')
  assert.equal(textOf({ content: 'plain' }), 'plain')
  assert.equal(textOf({ content: [{ type: 'image' }] }), '')
  assert.equal(textOf(undefined), '')
})

test('isUserAuthored rejects synthetic prompt inputs', () => {
  assert.equal(isUserAuthored(user('hi')), true)
  assert.equal(isUserAuthored({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), true)
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'ptc-mode', 'time-context', 'subagent-settled']) {
    assert.equal(isUserAuthored(user('noise', { kind })), false, kind)
  }
  assert.equal(isUserAuthored(assistant('text')), false)
})

test('buildTranscript drops system/tool and synthetic user turns, newest last', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'rules' }] },
    user('first'),
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd noise' }] },
    assistant('second'),
    { role: 'tool', content: [{ type: 'text', text: 'tool noise' }] },
    user('third'),
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'catalog noise' }] },
  ]
  const transcript = buildTranscript(messages)
  assert.equal(transcript, 'User: first\n\nAssistant: second\n\nUser: third')
  assert.ok(!transcript.includes('rules'))
  assert.ok(!transcript.includes('noise'))
  assert.equal(buildTranscript(messages, { historyMessages: 1 }), 'User: third')
})

test('buildTranscript keeps whole newest messages inside the character budget', () => {
  const messages = [user('a'.repeat(30)), assistant('b'.repeat(30)), user('c'.repeat(30))]
  const transcript = buildTranscript(messages, { totalChars: 80, perMessageChars: 100 })
  assert.ok(transcript.endsWith('User: ' + 'c'.repeat(30)))
  assert.ok(!transcript.includes('a'.repeat(30)))
})

test('buildTranscript keeps the conclusion of a long assistant reply', () => {
  const long = 'HEAD-' + 'x'.repeat(3000) + '-CONCL'
  const transcript = buildTranscript(
    [user('do it'), { role: 'assistant', content: [{ type: 'text', text: long }] }],
    { perMessageChars: 400, totalChars: 5000 },
  )
  assert.match(transcript, /Assistant: HEAD-/)
  assert.ok(transcript.includes('…'))
  assert.ok(transcript.endsWith('-CONCL'))
})

test('the newest assistant reply gets the larger budget', () => {
  // 400 chars for older messages; the newest assistant gets 1.5x = 600.
  const long = 'A'.repeat(500) + '-END'
  const transcript = buildTranscript([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'text', text: long }] }], {
    perMessageChars: 400,
    totalChars: 5000,
  })
  // The whole 504-char reply fits inside the 600 budget, conclusion intact.
  assert.ok(transcript.endsWith('A'.repeat(500) + '-END'))
  assert.match(transcript, /User: q/)
})

test('buildTranscript clips a lone oversize user message from its front within budget', () => {
  const transcript = buildTranscript([user('head-' + 'x'.repeat(200) + '-tail')], {
    totalChars: 50,
    perMessageChars: 500,
  })
  // "User: " label (6) plus at most 44 body chars; the head survives, never the tail.
  assert.ok(transcript.length <= 50)
  assert.ok(transcript.startsWith('User: head-'))
  assert.ok(!transcript.includes('-tail'))
})

test('buildTranscript keeps the last user even when 12 assistant texts follow it', () => {
  const messages = [user('我需要把最新那条 User 请求保留下来')]
  for (let index = 0; index < 12; index += 1) {
    messages.push(assistant('assistant text ' + index + ' ' + 'x'.repeat(50)))
  }
  const transcript = buildTranscript(messages, { historyMessages: 12, totalChars: 2000, perMessageChars: 500 })
  assert.match(transcript, /User: 我需要把最新那条 User 请求保留下来/)
})

test('buildTranscript preserves both the request and the reply conclusion under a tiny budget', () => {
  const messages = [
    user('请修复 Tab 不生效，并说明原因'),
    assistant('原因已找到。' + 'x'.repeat(2000) + ' 修复已生效。'),
  ]
  const transcript = buildTranscript(messages, { historyMessages: 8, perMessageChars: 8000, totalChars: 400 })
  assert.ok(transcript.length <= 400)
  // The request's head and the reply's conclusion are both present, never dropped.
  assert.match(transcript, /User: 请修复 Tab 不生效/)
  assert.match(transcript, /修复已生效。/)
})

test('lastConversationRole ignores synthetic messages', () => {
  assert.equal(lastConversationRole([user('a'), assistant('b')]), 'assistant')
  assert.equal(lastConversationRole([user('a'), user('queued', { kind: 'agent-message' })]), 'user')
  assert.equal(
    lastConversationRole([
      user('a'),
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd' }] },
    ]),
    'user',
  )
  assert.equal(lastConversationRole([]), undefined)
})

test('normalizePrediction strips wrappers, keeps one line, honours SKIP', () => {
  assert.equal(normalizePrediction('  "run the tests"  '), 'run the tests')
  assert.equal(normalizePrediction('first line\nsecond line'), 'first line')
  assert.equal(normalizePrediction('「继续优化这个函数」'), '继续优化这个函数')
  assert.equal(normalizePrediction('- 继续跑测试'), '继续跑测试')
  assert.equal(normalizePrediction('Suggestion: run the tests'), 'run the tests')
  assert.equal(normalizePrediction('```\nrun the tests\n```'), 'run the tests')
  assert.equal(normalizePrediction('SKIP'), '')
  assert.equal(normalizePrediction('skip - nothing natural'), '')
  assert.equal(normalizePrediction('   '), '')
  assert.equal(normalizePrediction('x'.repeat(300)).length, 160)
  assert.equal(normalizePrediction('x'.repeat(300), 80).length, 80)
})

test('normalizePrediction rejects assistant-voiced openers only', () => {
  assert.equal(normalizePrediction("Sure, I've updated the tests."), '')
  assert.equal(normalizePrediction('Done.'), '')
  assert.equal(normalizePrediction("I've fixed the parser"), '')
  assert.equal(normalizePrediction('Here is the patch'), '')
  // A user may legitimately start this way; do not drop it.
  assert.equal(normalizePrediction('好的，继续跑测试'), '好的，继续跑测试')
  assert.equal(normalizePrediction('继续看看'), '继续看看')
})

test('normalizeConfig clamps and drops blank strings', () => {
  const config = normalizeConfig({
    provider: '  ',
    model: ' deepseek-flash ',
    reasoningEffort: 'off',
    maxTokens: 1,
    historyMessages: 500,
    timeoutMs: 'nope',
    perMessageChars: 50,
    totalChars: 999999,
    maxPredictionChars: 10,
  })
  assert.equal(config.provider, undefined)
  assert.equal(config.model, 'deepseek-flash')
  assert.equal(config.reasoningEffort, 'off')
  assert.equal(config.maxTokens, 64)
  assert.equal(config.historyMessages, 50)
  assert.equal(config.timeoutMs, 20_000)
  assert.equal(config.perMessageChars, 200)
  assert.equal(config.totalChars, 40_000)
  assert.equal(config.maxPredictionChars, 40)
  assert.equal(config.enabled, true)
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
})

test('settingsView and sanitizeSettings keep only known fields', () => {
  assert.deepEqual(
    sanitizeSettings({ enabled: false, provider: ' p ', model: 'm', reasoningEffort: 'off', maxTokens: '128', nope: 1 }),
    { enabled: false, provider: 'p', model: 'm', reasoningEffort: 'off', maxTokens: 128 },
  )
  assert.deepEqual(sanitizeSettings(null), {})
  const view = settingsView(normalizeConfig({ enabled: false, maxTokens: 128 }))
  assert.equal(view.enabled, false)
  assert.equal(view.maxTokens, 128)
  assert.equal(view.provider, '')
})

test('resolveRoute prefers a cheap sibling and keeps an explicit route', async () => {
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }],
    listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }],
  }
  assert.deepEqual(await resolveRoute(llm, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(await resolveRoute(llm, {}), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(await resolveRoute(llm, { preferredModel: 'deepseek-flash' }), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  await assert.rejects(() => resolveRoute({ listProviders: () => [] }, {}), /no LLM provider/)
})

test('resolveRoute keeps the user model when it is the only option, and survives a failed discovery', async () => {
  const onlyPro = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'deepseek-v4-pro' }],
  }
  assert.deepEqual(await resolveRoute(onlyPro, { preferredModel: 'deepseek-v4-pro' }), {
    provider: 'p',
    model: 'deepseek-v4-pro',
  })
  const broken = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => {
      throw new Error('discovery offline')
    },
  }
  assert.deepEqual(await resolveRoute(broken, { preferredModel: 'selected' }), {
    provider: 'p',
    model: 'selected',
  })
  await assert.rejects(() => resolveRoute(broken, {}), /discovery offline/)
})

test('resolveEffort picks the cheapest supported effort only', async () => {
  const model = (efforts) => ({
    resolveModelInfo: async () => ({ reasoning: { efforts: efforts.map((id) => ({ id })) } }),
  })
  assert.equal(await resolveEffort(model(['high', 'max']), { provider: 'p', model: 'm' }), undefined)
  assert.equal(await resolveEffort(model(['off', 'low', 'high']), { provider: 'p', model: 'm' }), 'off')
  assert.equal(await resolveEffort(model(['minimal', 'high']), { provider: 'p', model: 'm' }), 'minimal')
  assert.equal(await resolveEffort({}, { provider: 'p', model: 'm' }), undefined)
  assert.equal(
    await resolveEffort(
      {
        resolveModelInfo: async () => {
          throw new Error('nope')
        },
      },
      { provider: 'p', model: 'm' },
    ),
    undefined,
  )
})

test('defaultSelection reads the app model, and tolerates a missing service', () => {
  const mounted = {
    get: (name) =>
      name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) }
        : undefined,
  }
  assert.deepEqual(defaultSelection(mounted), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(defaultSelection({ get: () => undefined }), undefined)
  assert.equal(defaultSelection({}), undefined)
  assert.equal(defaultSelection({ get: () => ({ currentSelection: () => { throw new Error('boom') } }) }), undefined)
})

function fakeCtx() {
  const appended = []
  const session = {
    id: 's1',
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'rules' }] },
      user('fix the failing test'),
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd' }] },
      assistant('I updated parse() in src/parse.ts.'),
    ],
    append: (...args) => appended.push(args),
  }
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }],
    listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'unused' }
    },
  }
  return {
    appended,
    session,
    ctx: {
      get: (name) =>
        name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
          : undefined,
      sessions: { get: (id) => (id === 's1' ? session : undefined) },
      llm,
    },
  }
}

test('predict wires transcript, cheap route, effort, and never touches the session log', async () => {
  const { ctx, appended } = fakeCtx()
  let sent
  ctx.llm.stream = async function* (options) {
    sent = options
    yield { type: 'text-delta', index: 0, text: ' "run ' }
    yield { type: 'text-delta', index: 0, text: 'the tests again" ' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const result = await predict(ctx, normalizeConfig({ maxTokens: 64 }), 's1', new AbortController().signal)
  assert.equal(result.text, 'run the tests again')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.provider, 'deepseek-account')
  assert.equal(result.effort, 'off')
  assert.equal(sent.provider, 'deepseek-account')
  assert.equal(sent.model, 'deepseek-flash')
  assert.equal(sent.reasoningEffort, 'off')
  assert.equal(sent.maxTokens, 64)
  assert.equal(sent.sessionId, 's1')
  assert.match(sent.messages[0].content[0].text, /User: fix the failing test/)
  assert.match(sent.messages[0].content[0].text, /Assistant: I updated parse\(\)/)
  assert.doesNotMatch(sent.messages[0].content[0].text, /cwd|rules/)
  assert.match(sent.system, /Ground every claim in the context/)
  assert.match(sent.system, /not proof the user accepted it/)
  assert.match(sent.system, /not an agenda/)
  assert.deepEqual(appended, [])
})

test('predict returns empty when the turn did not end on the assistant', async () => {
  const { ctx } = fakeCtx()
  let streamed = false
  ctx.sessions.get = () => ({ id: 's1', deriveMessages: () => [user('queued message')] })
  ctx.llm.stream = async function* () {
    streamed = true
    yield { type: 'text-delta', index: 0, text: 'wrong' }
  }
  assert.equal((await predict(ctx, normalizeConfig({}), 's1', new AbortController().signal)).text, '')
  assert.equal(streamed, false)
})

test('predict answers empty on SKIP and rejects an unknown session', async () => {
  const { ctx } = fakeCtx()
  ctx.llm.stream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'SKIP' }
  }
  assert.equal((await predict(ctx, normalizeConfig({}), 's1', new AbortController().signal)).text, '')
  await assert.rejects(
    () =>
      predict(
        { ...ctx, sessions: { get: () => undefined } },
        normalizeConfig({}),
        'missing',
        new AbortController().signal,
      ),
    /unknown session/,
  )
})

test('predict surfaces a failed finish and an already-aborted signal', async () => {
  const { ctx } = fakeCtx()
  ctx.llm.stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'OVERLOADED' } } }
  }
  await assert.rejects(() => predict(ctx, normalizeConfig({}), 's1', new AbortController().signal), /OVERLOADED/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    () => predict(ctx, normalizeConfig({}), 's1', aborted.signal),
    (error) => error.status === 499,
  )
})


test('lastTurnCompleted only accepts a completed or max-tokens turn', () => {
  const end = (kind) => [{ type: 'turn/end', data: { reason: { kind } } }]
  const session = (events) => ({
    id: 's',
    seq: events.length + 1,
    snapshotEvents: () => events,
    deriveMessages: () => [],
  })
  assert.equal(lastTurnCompleted(session(end('completed'))), true)
  assert.equal(lastTurnCompleted(session(end('max-tokens'))), true)
  assert.equal(lastTurnCompleted(session(end('aborted'))), false)
  assert.equal(lastTurnCompleted(session(end('error'))), false)
  assert.equal(lastTurnCompleted(session(end('blocked'))), false)
  assert.equal(lastTurnCompleted(session([{ type: 'assistant/message' }])), true)
  assert.equal(lastTurnCompleted({ deriveMessages: () => [] }), true)
  assert.equal(
    lastTurnCompleted({ id: 's', seq: 1, snapshotEvents: () => { throw new Error('boom') }, deriveMessages: () => [] }),
    true,
  )
})

test('an aborted turn never reaches the model', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let streamed = false
  ctx.llm.stream = async function* () {
    streamed = true
    yield { type: 'text-delta', index: 0, text: 'wrong' }
  }
  ctx.sessions.get = () => ({
    id: 'aborted-turn',
    seq: 8,
    snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'aborted' } } }],
    deriveMessages: () => [user('stop'), assistant('partial')],
  })
  assert.equal((await predict(ctx, normalizeConfig({}), 'aborted-turn', new AbortController().signal)).text, '')
  assert.equal(streamed, false)
})

test('one suggestion is cached, hit on the same input, invalidated by new content', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let calls = 0
  ctx.llm.stream = async function* () {
    calls += 1
    yield { type: 'text-delta', index: 0, text: '继续跑测试' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let transcript = () => [user('hi'), assistant('done')]
  const session = {
    id: 'cache-1',
    seq: 10,
    surface: { nodes: [10] },
    snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    deriveMessages: () => transcript(),
  }
  ctx.sessions.get = () => session

  const first = await predict(ctx, normalizeConfig({}), 'cache-1', new AbortController().signal)
  assert.equal(first.text, '继续跑测试')
  assert.equal(first.cached, undefined)
  assert.equal(calls, 1)

  const second = await predict(ctx, normalizeConfig({}), 'cache-1', new AbortController().signal)
  assert.equal(second.text, '继续跑测试')
  assert.equal(second.cached, true)
  assert.equal(calls, 1)

  // Same surface seq, different content: the fingerprint must differ.
  transcript = () => [user('a different request'), assistant('a different reply')]
  const third = await predict(ctx, normalizeConfig({}), 'cache-1', new AbortController().signal)
  assert.equal(third.text, '继续跑测试')
  assert.equal(third.cached, undefined)
  assert.equal(calls, 2)
})

test('a config change invalidates the suggestion', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let calls = 0
  ctx.llm.stream = async function* () {
    calls += 1
    yield { type: 'text-delta', index: 0, text: '继续跑测试' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.sessions.get = () => ({
    id: 'cache-cfg',
    seq: 4,
    snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    deriveMessages: () => [user('hi'), assistant('done')],
  })
  await predict(ctx, normalizeConfig({}), 'cache-cfg', new AbortController().signal)
  const cached = await predict(ctx, normalizeConfig({}), 'cache-cfg', new AbortController().signal)
  assert.equal(cached.cached, true)
  assert.equal(calls, 1)

  const changed = await predict(ctx, normalizeConfig({ model: 'deepseek-v4-pro' }), 'cache-cfg', new AbortController().signal)
  assert.equal(changed.cached, undefined)
  assert.equal(calls, 2)
})

test('a cached suggestion does not survive the turn becoming aborted', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let calls = 0
  ctx.llm.stream = async function* () {
    calls += 1
    yield { type: 'text-delta', index: 0, text: '继续跑测试' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let outcome = 'completed'
  const session = {
    id: 'cache-abort',
    seq: 6,
    snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: outcome } } }],
    deriveMessages: () => [user('hi'), assistant('done')],
  }
  ctx.sessions.get = () => session

  const first = await predict(ctx, normalizeConfig({}), 'cache-abort', new AbortController().signal)
  assert.equal(first.text, '继续跑测试')
  assert.equal(calls, 1)

  outcome = 'aborted'
  const second = await predict(ctx, normalizeConfig({}), 'cache-abort', new AbortController().signal)
  assert.equal(second.text, '')
  assert.equal(second.reason, 'turn-not-completed')
  assert.equal(second.cached, undefined)
  assert.equal(calls, 1) // eligibility is checked before the cache, no model call
})

test('a declined (SKIP) suggestion is cached too', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let calls = 0
  ctx.llm.stream = async function* () {
    calls += 1
    yield { type: 'text-delta', index: 0, text: 'SKIP' }
  }
  ctx.sessions.get = () => ({
    id: 'cache-skip',
    seq: 3,
    snapshotEvents: () => [],
    deriveMessages: () => [user('hi'), assistant('done')],
  })
  assert.equal((await predict(ctx, normalizeConfig({}), 'cache-skip', new AbortController().signal)).text, '')
  const again = await predict(ctx, normalizeConfig({}), 'cache-skip', new AbortController().signal)
  assert.equal(again.text, '')
  assert.equal(again.cached, true)
  assert.equal(calls, 1)
})


test('the master switch stops the model call entirely', async () => {
  clearPredictionCache()
  const { ctx } = fakeCtx()
  let streamed = false
  ctx.llm.stream = async function* () {
    streamed = true
    yield { type: 'text-delta', index: 0, text: 'wrong' }
  }
  const result = await predict(ctx, normalizeConfig({ enabled: false }), 's1', new AbortController().signal)
  assert.equal(result.text, '')
  assert.equal(result.reason, 'disabled')
  assert.equal(streamed, false)
})


test('collectOptions lists providers and survives one broken catalog', async () => {
  const ctx = {
    get: (name) =>
      name === 'llm'
        ? {
            listProviders: () => [
              { id: 'good', name: 'Good' },
              { id: 'broken', name: 'Broken' },
            ],
            listModels: async (id) => {
              if (id === 'broken') throw new Error('offline')
              return [{ id: 'm1', name: 'Model One' }]
            },
          }
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'good', model: 'm1' }) }
          : undefined,
  }
  const options = await collectOptions(ctx)
  assert.deepEqual(options.providers, [
    { id: 'good', name: 'Good' },
    { id: 'broken', name: 'Broken' },
  ])
  assert.deepEqual(options.models, [{ provider: 'good', id: 'm1', name: 'Model One' }])
  assert.equal(options.autoProvider, 'good')
})


test('a pinned effort the model does not advertise falls back to the cheapest supported', async () => {
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
  const route = { provider: 'p', model: 'm' }
  assert.equal(await chooseEffort(llm, route, undefined, 'minimal'), 'low')
  assert.equal(await chooseEffort(llm, route, undefined, 'high'), 'high')
  assert.equal(await chooseEffort(llm, route, undefined, ''), 'low')
  assert.equal(await chooseEffort({}, route, undefined, 'minimal'), undefined)
  const broken = { resolveModelInfo: async () => { throw new Error('offline') } }
  assert.equal(await chooseEffort(broken, route, undefined, 'minimal'), undefined)
})
