// Intent-first context and output regressions. Offline: no host or paid model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, lastConversationRole, normalizeConfig, normalizePrediction, predict, SYSTEM_PROMPT } from '../index.js'

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const image = () => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'IMAGE_SECRET' }] })
const lines = (text) => text.split(/\n\n(?=User:|Assistant:)/)
const length = (text) => Array.from(text).length

// Contract checks verify instructions exist, not that a real model follows them.
test('prompt prioritizes user intent, artifact corrections and abstention', () => {
  assert.match(SYSTEM_PROMPT, /existing artifact/i)
  assert.match(SYSTEM_PROMPT, /latest corrections and refusals/i)
  assert.match(SYSTEM_PROMPT, /actual object, scope, requested deliverable/i)
  assert.match(SYSTEM_PROMPT, /not evidence of user intent or approval/i)
  assert.match(SYSTEM_PROMPT, /generic.*tests.*documentation.*commits/i)
  assert.match(SYSTEM_PROMPT, /completed.*SKIP/i)
  assert.match(SYSTEM_PROMPT, /equally plausible.*context is missing/i)
  assert.match(SYSTEM_PROMPT, /omitted.*unfinished/i)
  assert.match(SYSTEM_PROMPT, /untrusted data/i)
  assert.match(SYSTEM_PROMPT, /Never suggest approving destructive actions/i)
})

test('six user turns survive progress chatter, with at most one final artifact each', () => {
  const prompts = [
    '比较方案 A 和 B 的延迟，只分析，不改代码。',
    '不是平均值，我关心高峰期的 TP99。',
    '比较项保留成本、延迟和回滚难度。',
    '刚才漏了上海地域，请用同样的口径。',
    '不要扩展成实施计划，还是比较这两个方案。',
    '按这些约束整理最后的结论。',
  ]
  const messages = []
  for (const [i, prompt] of prompts.entries()) {
    messages.push(user(prompt))
    for (let j = 0; j < 20; j += 1) messages.push(assistant(`PROGRESS_${i}_${j} ` + '进度'.repeat(1000)))
    messages.push(assistant(`FINAL_${i}：当前比较产物。`))
  }
  const transcript = buildTranscript(messages)
  for (const prompt of prompts) assert.ok(transcript.includes(prompt))
  assert.doesNotMatch(transcript, /PROGRESS_/)
  assert.equal(lines(transcript).length, 12)
  assert.match(transcript, /FINAL_0/)
  assert.match(transcript, /FINAL_5/)
  assert.ok(transcript.indexOf(prompts[0]) < transcript.indexOf(prompts[5]))
})

test('long requests keep goals and trailing constraints before older assistant prose', () => {
  const messages = []
  for (let i = 0; i < 6; i += 1) {
    messages.push(user(`GOAL_${i} ` + '🦊'.repeat(8000) + ` CONSTRAINT_${i}`))
    messages.push(assistant(`ARTIFACT_${i} ` + '答'.repeat(8000) + ` RESULT_${i}`))
  }
  const transcript = buildTranscript(messages)
  for (let i = 0; i < 6; i += 1) {
    assert.ok(transcript.includes(`GOAL_${i}`))
    assert.ok(transcript.includes(`CONSTRAINT_${i}`))
  }
  assert.match(transcript, /ARTIFACT_5/)
  assert.match(transcript, /RESULT_5$/)
  assert.ok(length(transcript) <= 6000)
  assert.ok(lines(transcript).length <= 12)
  assert.ok(transcript.isWellFormed())
})

test('an unrelated first task is not pinned outside the six-turn window', () => {
  const messages = [user('STALE_TOPIC'), assistant('STALE_ANSWER')]
  for (let i = 1; i <= 7; i += 1) messages.push(user(`REQUEST_${i}`), assistant(`ANSWER_${i}`))
  const transcript = buildTranscript(messages)
  assert.doesNotMatch(transcript, /STALE_|REQUEST_1|ANSWER_1/)
  for (let i = 2; i <= 7; i += 1) assert.ok(transcript.includes(`REQUEST_${i}`))
  assert.equal(lines(transcript).length, 12)
})

test('older artifacts keep both ends with a quarter budget, after their user request', () => {
  const request = '比较北京和上海的成本、延迟、回滚难度。' + '细节'.repeat(500) + '只分析，不实施。'
  const transcript = buildTranscript([
    user(request),
    assistant('ARTIFACT_START ' + '表格'.repeat(4000) + ' ARTIFACT_END'),
    user('用同样的口径整理结论'),
    assistant('最后的比较结论'),
  ])
  assert.ok(transcript.includes(request))
  const artifact = lines(transcript).find((line) => line.startsWith('Assistant: ARTIFACT_START'))
  assert.match(artifact, /ARTIFACT_END$/)
  assert.ok(length(artifact) <= 'Assistant: '.length + 400)
  assert.ok(transcript.indexOf(request) < transcript.indexOf(artifact))
})

test('non-text user messages remain turn boundaries and cannot borrow older requests', () => {
  const messages = [user('old request'), assistant('old answer'), image()]
  assert.equal(lastConversationRole(messages), 'user')
  assert.equal(buildTranscript(messages), '')
  messages.push(assistant('IMAGE_REPLY'))
  assert.equal(buildTranscript(messages), '')
  messages.push(user('文字任务'), assistant('文字结论'))
  const transcript = buildTranscript(messages)
  assert.doesNotMatch(transcript, /IMAGE_SECRET|IMAGE_REPLY/)
  assert.match(transcript, /User: 文字任务/)
})

test('empty or tool-call final messages never fall back to a progress artifact', () => {
  for (const final of [assistant(''), { role: 'assistant', content: [{ type: 'text', text: 'TOOL_PREFACE' }, { type: 'tool-call' }] }]) {
    const messages = [user('不要修改'), assistant('PROGRESS_NOT_FINAL'), final]
    assert.equal(buildTranscript(messages), '')
    const transcript = buildTranscript([...messages, user('现在解释原理'), assistant('原理结论')])
    assert.match(transcript, /不要修改/)
    assert.doesNotMatch(transcript, /PROGRESS_NOT_FINAL|TOOL_PREFACE/)
  }
})

test('configurable budgets include labels and separators without splitting Unicode', () => {
  const messages = []
  for (let i = 0; i < 30; i += 1) {
    messages.push(user(`Q${i} ` + '🦊'.repeat(4000) + ` END_Q${i}`))
    messages.push(assistant(`A${i} ` + '🦊'.repeat(4000) + ` END_A${i}`))
  }
  for (const historyMessages of [2, 3, 4, 11, 12, 50]) {
    for (const perMessageChars of [200, 1600, 8000]) {
      for (const totalChars of [1000, 6000]) {
        const transcript = buildTranscript(messages, { historyMessages, perMessageChars, totalChars })
        assert.ok(length(transcript) <= totalChars)
        assert.ok(lines(transcript).length <= historyMessages)
        assert.ok(lines(transcript).filter((line) => line.startsWith('User: ')).length <= Math.floor(historyMessages / 2))
        assert.match(transcript, /User: Q29/)
        assert.match(transcript, /END_Q29/)
        assert.match(transcript, /Assistant: A29/)
        assert.match(transcript, /END_A29$/)
        assert.ok(transcript.isWellFormed())
      }
    }
  }
})

test('missing textual context or a tool-call tail causes no model request', async () => {
  let calls = 0
  for (const messages of [
    [assistant('no user request')],
    [user('old'), assistant('old answer'), image(), assistant('unknown image')],
    [user('q'), assistant('')],
    [user('q'), { role: 'assistant', content: [{ type: 'text', text: 'preface' }, { type: 'tool-call' }] }],
  ]) {
    const ctx = {
      sessions: { get: () => ({ id: 'no-context', deriveMessages: () => messages }) },
      llm: { listProviders: () => { calls += 1; throw new Error('must not select a model') } },
    }
    const result = await predict(ctx, normalizeConfig({}), 'no-context', new AbortController().signal)
    assert.equal(result.text, '')
    assert.equal(result.reason, 'empty-transcript')
  }
  assert.equal(calls, 0)
})

test('output removes reasoning and controls, rejects punctuation, and clips by Unicode', () => {
  assert.equal(normalizePrediction('<think>PRIVATE</think>\n把比较改成表格'), '把比较改成表格')
  assert.equal(normalizePrediction('<think>unfinished'), '')
  assert.equal(normalizePrediction('\x1b[31m继续\x1b[0m\x1b]0;SECRET\x07\u202e'), '继续')
  assert.equal(normalizePrediction('SKIP: no clear follow-up'), '')
  assert.equal(normalizePrediction('...'), '')
  assert.equal(normalizePrediction('first\u2028second'), 'first')
  assert.equal(normalizePrediction('first\u2029second'), 'first')
  assert.equal(normalizePrediction('first\rsecond'), 'first')
  assert.equal(normalizePrediction('整理\t\t表格'), '整理 表格')
  const prediction = normalizePrediction('🦊测'.repeat(200))
  assert.equal(length(prediction), 160)
  assert.ok(prediction.isWellFormed())
})
