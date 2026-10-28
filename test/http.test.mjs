// Drives the real HTTP handler over a real socket: routing, JSON shape,
// same-origin policy, and the timeout path. The model itself is faked, so no
// credentials or network are required.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createConfigHandler, createPredictHandler, normalizeConfig } from '../index.js'

const messages = [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the failing test' }] },
  {
    role: 'assistant',
    source: { kind: 'model', provider: 'p', model: 'm' },
    content: [{ type: 'text', text: 'Updated parse() in src/parse.ts.' }],
  },
]

const session = (id) => ({ id, deriveMessages: () => messages })

const ctx = {
  sessions: {
    get: (id) => (id === 's1' || id === 'hang' ? session(id) : undefined),
  },
  llm: {
    listProviders: () => [{ id: 'deepseek-account' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
    async *stream(options) {
      if (options.sessionId === 'hang') {
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve()
          else options.signal.addEventListener('abort', resolve, { once: true })
        })
        throw new Error('aborted by timeout')
      }
      yield { type: 'text-delta', index: 0, text: '继续跑测试' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

const handler = createPredictHandler(ctx, { timeoutMs: 1_000 })

// Settings endpoint: a fake configEditor stands in for the platform service.
const configState = { options: normalizeConfig({}) }
const edits = []
const configHandler = createConfigHandler(
  {
    get: (name) =>
      name === 'configEditor'
        ? {
            entries: () => [
              { options: { id: 'composer-predictions', name: '@lsfcy/dsh-composer-predictions' } },
              { options: { id: 'other', name: 'other' } },
            ],
            edit: async (entry, change) => {
              edits.push({ entry, next: change({ provider: 'inherited' }, {}) })
            },
          }
        : undefined,
  },
  () => configState.options,
  (next) => {
    configState.options = next
  },
)

const server = http.createServer((request, response) => {
  if ((request.url || '').startsWith('/composer-predictions/config')) configHandler(request, response)
  else handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`
after(() => new Promise((resolve) => server.close(resolve)))

const post = (body, headers = {}) =>
  fetch(`${base}/composer-predictions/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('POST returns the predicted line and its route', async () => {
  const response = await post({ sessionId: 's1' }, { origin: base })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.text, '继续跑测试')
  assert.equal(payload.provider, 'deepseek-account')
  assert.equal(payload.model, 'deepseek-flash')
  assert.equal(payload.effort, 'off')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('only POST is accepted', async () => {
  const response = await fetch(`${base}/composer-predictions/predict`)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})

test('a foreign origin or a cross-site request is refused', async () => {
  const foreign = await post({ sessionId: 's1' }, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const crossSite = await post({ sessionId: 's1' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  const nullable = await post({ sessionId: 's1' }, { origin: 'null' })
  assert.equal(nullable.status, 403)
})

test('a non-JSON body is refused before any model call', async () => {
  const response = await post('{}', { 'content-type': 'text/plain' })
  assert.equal(response.status, 403)
})

test('malformed JSON and unknown sessions answer 400 / 404', async () => {
  const malformed = await post('{not json')
  assert.equal(malformed.status, 400)
  const unknown = await post({ sessionId: 'nope' })
  assert.equal(unknown.status, 404)
  const payload = await unknown.json()
  assert.match(payload.error, /unknown session/)
})

test('a slow model call is aborted at the configured timeout', async () => {
  const started = Date.now()
  const response = await post({ sessionId: 'hang' })
  assert.equal(response.status, 504)
  assert.ok(Date.now() - started >= 900, 'the handler waited for its own timeout')
})


test('config GET returns the effective settings', async () => {
  const response = await fetch(`${base}/composer-predictions/config`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.config.enabled, true)
  assert.equal(payload.config.model, '')
  assert.equal(payload.config.maxTokens, 512)
})

test('config POST persists through configEditor and returns the new snapshot', async () => {
  const configResponse = await fetch(`${base}/composer-predictions/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ config: { enabled: false, model: 'deepseek-flash', maxTokens: '128' } }),
  })
  assert.equal(configResponse.status, 200)
  const payload = await configResponse.json()
  assert.equal(payload.config.enabled, false)
  assert.equal(payload.config.model, 'deepseek-flash')
  assert.equal(payload.config.maxTokens, 128)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].entry.options.id, 'composer-predictions')
  assert.deepEqual(edits[0].next, { provider: 'inherited', enabled: false, model: 'deepseek-flash', maxTokens: 128 })
})

test('config POST rejects malformed JSON and foreign origins', async () => {
  const malformed = await fetch(`${base}/composer-predictions/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(malformed.status, 400)
  const foreign = await fetch(`${base}/composer-predictions/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}',
  })
  assert.equal(foreign.status, 403)
})
