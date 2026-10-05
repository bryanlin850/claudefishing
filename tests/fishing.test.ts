import type { On } from 'claude-code'
import { MOD_VERSION } from '../types/version'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { FishingSwitch, HeartbeatResponse, ModUpdate, PlayerSummary } from '../types/protocol'

type Sent = { url: string; auth: string | undefined; body: Record<string, unknown>; at: number }

type Answer = { status: number; body: unknown }

type ServerState = {
  down: boolean
  /** Requests arrive but no answer ever comes back (a black-holed network). */
  hang: boolean
  clientConnected: boolean
  buff: { active: boolean; pct: number; expiresAt: number | null }
  sessionCount: number
  machines: number
  linked: boolean
  /** The heartbeat answer's word on this session's plugin (null: up to date). */
  modUpdate: ModUpdate | null
  /** The machine's switch as the server keeps it (null: a server from before the switch). */
  fishing: FishingSwitch | null
  pair: Record<string, unknown>
  /** Answers by path ('/api/link/claim'), from the request body; heartbeat and pair answer from the fields above. */
  answers: Record<string, (body: Record<string, unknown>) => Answer>
}

type Asked = { question: string; header: string; options: string[] }

type WorldOptions = {
  files?: Record<string, string>
  store?: Record<string, unknown>
  /** $.state as a previous load of the module left it (a hot reload). */
  state?: Record<string, unknown>
  chromeMissing?: boolean
  /** Each $.fs.write takes this long on the clock. */
  writeMs?: number
}

const IDENTITY = '/home/cat/.claudefishing/identity.json'
const FISHING_FILE = '/home/cat/.claudefishing/fishing.json'
const SECRET = 'ab'.repeat(32)
const TMP = /^\/home\/cat\/\.claudefishing\/identity\.json\.[0-9a-f]{12}\.tmp$/

function heartbeatResponse(server: ServerState): HeartbeatResponse {
  return {
    ok: true,
    serverTime: 5_000_000,
    clientConnected: server.clientConnected,
    player: { name: 'Mochi', level: 3, rank: 'Driftwood', money: 120, totalCaught: 12 },
    machines: server.machines,
    linked: server.linked,
    presence: {
      playable: true,
      sessionCount: server.sessionCount,
      model: 'Opus 5.5',
      effort: 'high',
      working: false,
      buff: { ...server.buff, potentialPct: 0.114 },
      modUpdate: server.modUpdate,
    },
    modUpdate: server.modUpdate,
    ...(server.fishing !== null ? { fishing: server.fishing } : {}),
  }
}

// The engine beneath the plugin, answered from memory: a test has no real fs, network or process.
function world(on: On, opts: WorldOptions = {}) {
  const files = new Map(Object.entries(opts.files ?? {}))
  const state = new Map(Object.entries(opts.state ?? {}))
  const sent: Sent[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const copies: string[] = []
  /** AskUserQuestion calls, and the label the person picks (null: they dismiss it). */
  const asks: Asked[] = []
  const person: { answer: string | null } = { answer: null }
  const argvs: string[][] = []
  /** `next`: the id a /clear or /resume moves to inside session.end; null = the engine moves later (the test sets `id`). */
  const session: { id: string; next: string | null } = { id: 'sess-1', next: 'sess-2' }
  const server: ServerState = {
    down: false,
    hang: false,
    clientConnected: false,
    buff: { active: false, pct: 0, expiresAt: null },
    sessionCount: 1,
    machines: 1,
    linked: false,
    modUpdate: null,
    fishing: null,
    pair: { ok: true, code: 'K7Q2ZP', expiresAt: 9_999_999 },
    answers: {},
  }
  /** How long each tool's call takes (its permission prompt or question included). */
  const toolMs: Record<string, number> = {}
  /** What the settings hooks beneath answer a permission request with. */
  const permission: { answer: Record<string, unknown> } = { answer: {} }
  /** Runs before a $.fs.write lands: another process acting meanwhile. */
  const beforeWrite: { run: ((path: string) => void) | null } = { run: null }
  const clock = mock.clock(on, { now: 1_000_000 })
  /** $.store: this install's, as plugins before 0.3.0 read it. */
  const store = new Map(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    store.delete((e as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  mock.env(on, { HOME: '/home/cat' })
  on('state.get', ($, e) => ({ value: { value: state.get((e as { key: string }).key), version: 0 } }) as never)
  on('state.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    state.set(key, JSON.parse(JSON.stringify(value)))
    return { value: { isSet: true, version: 1 } } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.end', ($, e) => {
    const ended = e.sessionId
    if ((e.reason === 'clear' || e.reason === 'resume') && session.next !== null) session.id = session.next // the process goes on
    return { sessionId: ended }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', async ($, e) => {
    const ms = toolMs[e.tool]
    if (ms !== undefined) await clock.sleep(ms)
    const questions = (e as { questions?: { question: string; header: string; options: { label: string }[] }[] }).questions
    if (e.tool === 'AskUserQuestion' && questions !== undefined) {
      const [q] = questions
      asks.push({ question: q!.question, header: q!.header, options: q!.options.map(o => o.label) })
      if (person.answer === null) return { deny: 'The user dismissed the question' } as never
      return { result: { questions, answers: { [q!.question]: person.answer } } } as never
    }
    return { result: 'ok' } as never
  })
  on('classic.PermissionRequest', () => permission.answer)
  on('classic.Notification', () => ({}))
  on('classic.Elicitation', () => ({}))
  on('classic.ElicitationResult', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.id', () => ({ value: session.id }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    if (opts.writeMs !== undefined) await clock.sleep(opts.writeMs)
    beforeWrite.run?.(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    let exitCode = 0
    if (argv[0] === 'ln') {
      // link(2): never replaces an existing file
      if (files.has(argv[2]!) || !files.has(argv[1]!)) exitCode = 1
      else files.set(argv[2]!, files.get(argv[1]!)!)
    } else if (argv[0] === 'mv') {
      if (!files.has(argv[1]!)) exitCode = 1
      else {
        files.set(argv[2]!, files.get(argv[1]!)!)
        files.delete(argv[1]!)
      }
    } else if (argv[0] === 'rm') {
      files.delete(argv.at(-1)!)
    } else if (opts.chromeMissing && argv.includes('Google Chrome')) {
      exitCode = 1
    }
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
    if (server.down) return { deny: 'ECONNREFUSED: Unable to connect' }
    const body = JSON.parse(e.init?.body ?? '{}')
    sent.push({ url: e.url, auth: e.init?.headers?.authorization, body, at: clock.now() })
    if (server.hang) await clock.sleep(60 * 60_000)
    const route = Object.keys(server.answers).find(path => e.url.endsWith(path))
    const answer: Answer = route !== undefined ? server.answers[route]!(body) : { status: 200, body: e.url.endsWith('/api/pair') ? server.pair : heartbeatResponse(server) }
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: JSON.stringify(answer.body) } }
  })
  const beats = () => sent.filter(s => s.url.endsWith('/api/heartbeat'))
  const pairs = () => sent.filter(s => s.url.endsWith('/api/pair'))
  const lastBeat = () => beats().at(-1)?.body
  /** Requests to one route ('/api/link/claim'). */
  const to = (path: string) => sent.filter(s => s.url.endsWith(path))
  /** The machine's switch as the file has it (undefined: no file). */
  const fishing = (): FishingSwitch | undefined => {
    const text = files.get(FISHING_FILE)
    return text === undefined ? undefined : JSON.parse(text)
  }
  return { files, state, store, fishing, sent, beats, lastBeat, pairs, to, statuses, toasts, copies, asks, person, argvs, clock, session, server, toolMs, permission, beforeWrite }
}

const START = { cwd: '/proj', surface: null, isInteractive: false } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const DONE = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' } as const
const SWITCH = {
  requested_model: 'haiku',
  source: 'command',
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0,
  pricing: 'catalog',
} as const

describe('identity', () => {
  test('mints ~/.claudefishing/identity.json once, owner-only, and signs every request with it', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const identity = JSON.parse(w.files.get(IDENTITY) ?? '{}')
    expect(identity.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.createdAt).toBe(1_000_000)
    const tmp = w.argvs[1]?.[2] ?? ''
    expect(tmp).toMatch(TMP)
    // written whole to a temp file, then linked into place (which never replaces a file), then the temp removed
    expect(w.argvs).toEqual([
      ['mkdir', '-p', '-m', '700', '/home/cat/.claudefishing'],
      ['chmod', '600', tmp],
      ['ln', tmp, IDENTITY],
      ['rm', '-f', tmp],
    ])
    expect([...w.files.keys()]).toEqual([IDENTITY])
    expect(w.beats()[0]?.url).toBe('https://claudefishing.io/api/heartbeat')
    expect(w.beats()[0]?.auth).toBe(`Bearer ${identity.secret}`)
  })

  test('reuses an existing identity without rewriting it', async ($, on) => {
    const stored = JSON.stringify({ secret: SECRET, createdAt: 42 })
    const w = world(on, { files: { [IDENTITY]: stored } })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.files.get(IDENTITY)).toBe(stored)
    expect(w.argvs).toEqual([])
    expect(w.beats()[0]?.auth).toBe(`Bearer ${SECRET}`)
  })

  test('keeps an unreadable identity file aside and creates a new one', async ($, on) => {
    const w = world(on, { files: { [IDENTITY]: '{"secret":"short"}' } })
    await $.session.start(START)
    await w.clock.settle()
    expect(JSON.parse(w.files.get(IDENTITY) ?? '{}').secret).toMatch(/^[0-9a-f]{64}$/)
    expect(w.files.get(`${IDENTITY}.corrupt-1000000`)).toBe('{"secret":"short"}')
    const { text } = await $.command.run({ command: 'fishing', args: '', ...TYPED })
    expect(text).toContain(`identity: ${IDENTITY} (stays on this machine; the unreadable one was kept as ${IDENTITY}.corrupt-1000000)`)
  })

  test('two sessions minting at once end up with the one identity that landed first', async ($, on) => {
    const w = world(on)
    const theirs = JSON.stringify({ secret: SECRET, createdAt: 7 })
    w.beforeWrite.run = path => {
      if (TMP.test(path)) w.files.set(IDENTITY, theirs) // another process links its file while this one writes
    }
    await $.session.start(START)
    await w.clock.settle()
    expect(w.files.get(IDENTITY)).toBe(theirs)
    expect([...w.files.keys()]).toEqual([IDENTITY])
    expect(w.beats()[0]?.auth).toBe(`Bearer ${SECRET}`)
  })

  test('callers in one session share one load: a single identity signs everything', async ($, on) => {
    const w = world(on, { writeMs: 10 })
    const start = $.session.start(START)
    const open = $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    await w.clock.advance(100)
    await start
    await open
    expect(w.argvs.filter(a => a[0] === 'ln')).toHaveLength(1)
    const secret = JSON.parse(w.files.get(IDENTITY) ?? '{}').secret
    expect(w.sent.length).toBeGreaterThan(1)
    expect(w.sent.every(s => s.auth === `Bearer ${secret}`)).toBe(true)
  })
})

describe('heartbeats', () => {
  test('the first beat: session model, no effort before a turn, not working, no activity yet', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.beats()).toHaveLength(1)
    expect(w.beats()[0]?.body).toEqual({
      sessionId: 'sess-1',
      enabled: true,
      model: 'claude-opus-5-5',
      effort: null,
      working: false,
      activeAgoMs: null,
      modVersion: MOD_VERSION,
      fishing: { on: true, rev: 0 },
    })
  })

  test('serverUrl comes from userConfig (trailing slash dropped)', { options: { serverUrl: 'http://127.0.0.1:8792/' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.beats()[0]?.url).toBe('http://127.0.0.1:8792/api/heartbeat')
  })

  test('a turn: working at once, model/effort from the main-loop step, activeAgoMs from the last activity', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 0, effort: null }))

    await w.clock.advance(1_000)
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'max', messageCount: 1 })) void chunk
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'max', working: true }))

    await w.clock.advance(2_000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 0, model: 'claude-sonnet-5-5', effort: 'max' }))

    const count = w.beats().length
    await w.clock.set(1_060_000) // nothing changed: nothing sent for a minute
    expect(w.beats()).toHaveLength(count)
    await w.clock.set(1_065_000) // the keepalive, on the first tick a minute after the last beat
    expect(w.beats()).toHaveLength(count + 1)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 62_000 }))
  })

  test('a model without effort reports null', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001', messageCount: 1 })) void chunk
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ model: 'claude-haiku-4-5-20251001', effort: null }))
  })

  test('/model reports the new model at once, drops the old effort until a step, and survives a reload', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 1 })) void chunk
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    const count = w.beats().length
    await $.classic.PostModelSwitch({ ...SWITCH, from_model: 'claude-opus-5-5', to_model: 'claude-haiku-4-5-20251001' })
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count + 1)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ model: 'claude-haiku-4-5-20251001', effort: null }))
    expect(w.state.get('activity')).toEqual(expect.objectContaining({ step: { model: 'claude-haiku-4-5-20251001', effort: null } }))

    await $.turn.start({ text: 'again', turnId: 't2' })
    for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-4-5-20251001', effort: 'low', messageCount: 3 })) void chunk
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ model: 'claude-haiku-4-5-20251001', effort: 'low' }))
  })

  test('a /model to the same model changes nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) void chunk
    await w.clock.settle()
    const count = w.beats().length
    await $.classic.PostModelSwitch({ ...SWITCH, from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5' })
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count)
  })

  test('a turn whose end never comes stops counting as working after 30 min', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.advance(29 * 60_000)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true }))
    await w.clock.advance(2 * 60_000)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false }))
  })

  test('a subagent that outlives the main turn keeps the session working until its own end', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const chunk of $.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })) void chunk
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true }))

    await w.clock.advance(65_000) // the keepalive a minute after the last beat
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 60_000 }))

    await $.turn.complete({ ...DONE, turnId: 's1', agentId: 'a1' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 0 }))
  })

  test('activity after a long idle beats at once; activity while active waits for the timer', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    let count = w.beats().length

    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never) // a background tool call between turns
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count)

    await w.clock.advance(6 * 60_000)
    count = w.beats().length
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count + 1)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ activeAgoMs: 0, working: false }))
  })

  test('the running turn and its subagents are kept in $.state', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(w.state.get('turn')).toEqual({ running: true, agents: [], waiting: false })
    for await (const chunk of $.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })) void chunk
    expect(w.state.get('turn')).toEqual({ running: true, agents: ['a1'], waiting: false })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 's1', agentId: 'a1' })
    expect(w.state.get('turn')).toEqual({ running: false, agents: [], waiting: false })
  })

  test('a hot reload mid-turn keeps reporting working', async ($, on) => {
    // what the module left in $.state before the reload: a turn running, one tool call a minute ago
    const w = world(on, {
      state: {
        turn: { running: true, agents: ['a1'], waiting: false },
        activity: { lastActiveAt: 1_000_000 - 60_000, step: { model: 'claude-opus-5-5', effort: 'high' } },
      },
    })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 60_000, effort: 'high' }))
    await w.clock.advance(10 * 60_000) // a long tool run: still the turn
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 11 * 60_000 }))
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 's1', agentId: 'a1' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 0 }))
  })
})

describe('waiting on the person', () => {
  test('a permission prompt is not working and stamps no activity; the tool running on is', async ($, on) => {
    const w = world(on)
    w.toolMs.Bash = 25 * 60_000 + 5_000 // the person answers after 25 min, then it runs 5 s
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true }))

    const count = w.beats().length
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count + 1) // at once
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 0 }))
    const { text } = await $.command.run({ command: 'fishing', args: '', ...TYPED })
    expect(text).toContain('this session: model claude-opus-5-5 · effort not known until a turn runs · waiting on you')

    await w.clock.advance(24 * 60_000)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 24 * 60_000 }))

    await w.clock.advance(60_000 + 5_000)
    await call
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 0 }))
  })

  test('a permission request a hook beneath answers shows no prompt: still working', async ($, on) => {
    const w = world(on)
    w.permission.answer = { decision: { behavior: 'allow' } }
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true }))
    expect(w.state.get('turn')).toEqual(expect.objectContaining({ waiting: false }))
  })

  test('AskUserQuestion and ExitPlanMode wait on the person for the whole call', async ($, on) => {
    const w = world(on)
    w.toolMs.AskUserQuestion = 3 * 60_000
    w.toolMs.ExitPlanMode = 60_000
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      const call = $.tool.call({ tool } as never)
      await w.clock.settle()
      expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: 0 }))
      await w.clock.advance(w.toolMs[tool]!)
      await call
      await w.clock.settle()
      expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 0 }))
    }
  })

  test('a prompt notification waits; the next step goes on; other notifications change nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    await $.classic.Notification({ message: 'Signed in', notification_type: 'auth_success' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true }))

    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false }))

    await w.clock.advance(1_000)
    for await (const chunk of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 3 })) void chunk
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 0 }))
  })

  test('an MCP elicitation waits until it is answered', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    await $.classic.Elicitation({ mcp_server_name: 'tickets', message: 'Which project?' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false }))
    await w.clock.advance(2 * 60_000)
    await $.classic.ElicitationResult({ mcp_server_name: 'tickets', action: 'accept' })
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: true, activeAgoMs: 0 }))
  })
})

describe('status line', () => {
  test('game closed, in game, and the buff from the heartbeat response', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('🎣 game closed')

    w.server.clientConnected = true
    w.server.buff = { active: true, pct: 0.114, expiresAt: null }
    await w.clock.advance(60_000)
    expect(w.statuses.at(-1)).toBe('🎣 in game · ⚡+11%')

    w.server.clientConnected = false
    await w.clock.advance(60_000)
    expect(w.statuses.at(-1)).toBe('🎣 game closed · ⚡+11%')
  })

  test('after /fishing open: "opening game" and a beat every tick until the server sees the window', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const { text } = await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    expect(text).toBe('opened in a Chrome app window')
    expect(w.statuses.at(-1)).toBe('🎣 opening game')
    const status = await $.command.run({ command: 'fishing', args: 'status', ...TYPED })
    expect(status.text).toContain('\ngame: opening\n')

    const count = w.beats().length
    await w.clock.advance(5_000) // still loading
    expect(w.beats()).toHaveLength(count + 1)
    expect(w.statuses.at(-1)).toBe('🎣 opening game')

    w.server.clientConnected = true // it joined
    await w.clock.advance(5_000)
    expect(w.beats()).toHaveLength(count + 2)
    expect(w.statuses.at(-1)).toBe('🎣 in game')
    await w.clock.advance(55_000) // then only the keepalive, a minute after the last beat
    expect(w.beats()).toHaveLength(count + 2)
    await w.clock.advance(5_000)
    expect(w.beats()).toHaveLength(count + 3)
  })

  test('a window that never joins: "game closed" again after 45 s, then keepalives only', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    await w.clock.advance(40_000)
    expect(w.beats()).toHaveLength(9) // the first, then one every 5 s
    expect(w.statuses.at(-1)).toBe('🎣 opening game')
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
    await w.clock.advance(50_000)
    expect(w.beats()).toHaveLength(9)
    await w.clock.advance(5_000) // a minute after the last beat
    expect(w.beats()).toHaveLength(10)
  })

  test('/fishing off while a window is awaited stops the beats at once', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    await $.command.run({ command: 'fishing', args: 'off', ...TYPED })
    const count = w.sent.length
    await w.clock.advance(45_000)
    expect(w.sent).toHaveLength(count)
    expect(w.statuses.at(-1)).toBe('🎣 off')
  })

  test('server down: offline, nothing throws, and it recovers', async ($, on) => {
    const w = world(on)
    w.server.down = true
    await $.session.start(START)
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('🎣 offline')
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('🎣 offline')

    const open = await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    expect(open.text).toBe('server unreachable at https://claudefishing.io (connection refused)')
    const status = await $.command.run({ command: 'fishing', args: '', ...TYPED })
    expect(status.text).toMatch(/^fishing on · server https:\/\/claudefishing\.io · offline \(connection refused\)\n/)
    expect(w.argvs.filter(a => a[0] === 'open')).toEqual([])

    w.server.down = false
    await w.clock.advance(60_000)
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('a newer plugin: "update available" and one toast with the command', async ($, on) => {
    const w = world(on)
    w.server.modUpdate = { required: false, latest: '0.3.0', min: null, command: 'claude plugin update claudefishing@claudefishing' }
    await $.session.start(START)
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('🎣 game closed · update available')
    expect(w.toasts).toEqual([`🎣 claudefishing ${MOD_VERSION}: 0.3.0 is out. Update in a terminal: claude plugin update claudefishing@claudefishing`])
    await w.clock.advance(60_000)
    expect(w.toasts).toHaveLength(1)
  })

  test('a plugin below the server minimum: the status line says so, and /fishing status says how', async ($, on) => {
    const w = world(on)
    w.server.modUpdate = { required: true, latest: '0.3.0', min: '0.3.0', command: 'claude plugin update claudefishing@claudefishing' }
    await $.session.start(START)
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('🎣 update the plugin to play (/fishing status)')
    expect(w.toasts.at(-1)).toContain('the game needs 0.3.0 or newer')
    const { text } = await $.command.run({ command: 'fishing', args: '', ...TYPED })
    expect(text).toContain(`plugin: ${MOD_VERSION}, the game needs 0.3.0 or newer. Update in a terminal, then restart Claude Code: claude plugin update claudefishing@claudefishing`)
  })
})

describe('/fishing', () => {
  test('status (no argument) lists the link, game, model, effort, buff, sessions and identity path', async ($, on) => {
    const w = world(on)
    w.server.sessionCount = 2
    w.server.buff = { active: true, pct: 0.12, expiresAt: 5_000_000 + 3 * 60_000 }
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: '', ...TYPED })
    expect(text).toBe(
      [
        'fishing on · server https://claudefishing.io · online',
        'game: closed (/fishing open)',
        'player: Mochi · level 3 Driftwood · $120',
        'devices: this one only (/fishing link plays Mochi on another too)',
        'sessions: 2 live on this machine · shown as Opus 5.5 · high',
        'buff: ⚡+12%, 3 min left',
        'this session: model claude-opus-5-5 · effort not known until a turn runs',
        `identity: ${IDENTITY} (stays on this machine)`,
        'usage: /fishing [status|open|on|off|link [code]|unlink]',
      ].join('\n'),
    )
  })

  test('off sends enabled:false, says off and stops the beats; on resumes them', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const off = await $.command.run({ command: 'fishing', args: 'off', ...TYPED })
    expect(off.text).toMatch(/^fishing off: /)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-1', enabled: false }))
    expect(w.statuses.at(-1)).toBe('🎣 off')

    const count = w.sent.length
    await w.clock.advance(60_000)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    expect(w.sent).toHaveLength(count)
    expect(w.statuses.at(-1)).toBe('🎣 off')

    const back = await $.command.run({ command: 'fishing', args: 'on', ...TYPED })
    expect(back.text).toBe('fishing on: 🎣 game closed (https://claudefishing.io)')
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, working: true }))
    await w.clock.advance(60_000)
    expect(w.sent).toHaveLength(count + 2)
  })

  test('off is remembered for new sessions on the machine: the server hears it once, nothing opens', async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":false,"rev":3}\n' } })
    await $.session.start({ ...START, isInteractive: true })
    await w.clock.advance(60_000)
    expect(w.sent.map(s => s.body)).toEqual([expect.objectContaining({ enabled: false, fishing: { on: false, rev: 3 } })])
    await w.clock.advance(120_000)
    expect(w.sent).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe('🎣 off')
  })

  test('open pairs with reason manual and opens a Chrome app window', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    expect(text).toBe('opened in a Chrome app window')
    expect(w.pairs()).toEqual([expect.objectContaining({ body: { sessionId: 'sess-1', reason: 'manual' }, url: 'https://claudefishing.io/api/pair' })])
    expect(w.argvs.at(-1)).toEqual(['open', '-na', 'Google Chrome', '--args', '--app=https://claudefishing.io/#pair=K7Q2ZP'])
  })

  test('open turns fishing on first when it is off, so the game does not open locked', async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":false,"rev":1}\n' } })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.sent.map(s => s.body.enabled)).toEqual([false]) // the off, told once
    w.sent.length = 0
    const { text } = await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    expect(text).toBe('fishing on · opened in a Chrome app window')
    expect(w.sent.map(s => s.url.replace('https://claudefishing.io', ''))).toEqual(['/api/heartbeat', '/api/pair'])
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-1', enabled: true, fishing: { on: true, rev: 2 } }))
    expect(w.fishing()).toEqual({ on: true, rev: 2 })
    expect(w.statuses.at(-1)).toBe('🎣 opening game')
    w.server.clientConnected = true
    await w.clock.advance(60_000)
    expect(w.beats()).toHaveLength(2) // stored: the next tick's beat reads it, and hears the window joined
    expect(w.statuses.at(-1)).toBe('🎣 in game')
  })

  test('open falls back to the default browser without Chrome', async ($, on) => {
    const w = world(on, { chromeMissing: true })
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'open', ...TYPED })
    expect(text).toBe('opened in the default browser')
    expect(w.argvs.at(-1)).toEqual(['open', 'https://claudefishing.io/#pair=K7Q2ZP'])
  })

  test('an unknown argument shows the usage', async ($, on) => {
    world(on)
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'fly', ...TYPED })
    expect(text).toBe('usage: /fishing [status|open|on|off|link [code]|unlink]')
  })
})

describe('the switch', () => {
  test("off and on flip the machine's switch: the file, this install's store and every beat carry it", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toBeUndefined() // never flipped: no file
    expect(w.lastBeat()?.fishing).toEqual({ on: true, rev: 0 })

    await $.command.run({ command: 'fishing', args: 'off', ...TYPED })
    expect(w.fishing()).toEqual({ on: false, rev: 1 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([false, 1])
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: false, fishing: { on: false, rev: 1 } }))
    // Off again: one flip more, told again (the server closes any window opened since).
    await $.command.run({ command: 'fishing', args: 'off', ...TYPED })
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: false, fishing: { on: false, rev: 2 } }))

    await $.command.run({ command: 'fishing', args: 'on', ...TYPED })
    expect(w.fishing()).toEqual({ on: true, rev: 3 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([true, 3])
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, fishing: { on: true, rev: 3 } }))
    // Written whole: a temp file, moved over the switch.
    expect(w.argvs.filter(a => a[0] === 'mv').map(a => a[2])).toEqual([FISHING_FILE, FISHING_FILE, FISHING_FILE])
    expect([...w.files.keys()].filter(k => k.endsWith('.tmp'))).toEqual([])
  })

  test("another session's flip reaches this one within a tick, both ways", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const count = w.sent.length
    w.files.set(FISHING_FILE, '{"on":false,"rev":1}\n') // /fishing off in another session
    await w.clock.advance(5_000)
    expect(w.sent).toHaveLength(count + 1)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: false, fishing: { on: false, rev: 1 } }))
    expect(w.statuses.at(-1)).toBe('🎣 off')
    await w.clock.advance(120_000)
    expect(w.sent).toHaveLength(count + 1)

    w.files.set(FISHING_FILE, '{"on":true,"rev":2}\n')
    await w.clock.advance(5_000)
    expect(w.sent).toHaveLength(count + 2)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, fishing: { on: true, rev: 2 } }))
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('an off the server never answered goes again a keepalive later, until it is', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    w.server.hang = true
    const off = $.command.run({ command: 'fishing', args: 'off', ...TYPED })
    await w.clock.advance(4_000) // no answer
    await off
    const count = w.beats().length
    await w.clock.advance(55_000)
    expect(w.beats()).toHaveLength(count)
    await w.clock.advance(5_000) // a keepalive after the try: again (no answer either)
    expect(w.beats()).toHaveLength(count + 1)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: false, fishing: { on: false, rev: 1 } }))
    w.server.hang = false
    await w.clock.advance(60_000) // and again, answered
    expect(w.beats()).toHaveLength(count + 2)
    await w.clock.advance(180_000)
    expect(w.beats()).toHaveLength(count + 2)
  })

  test('an off from before 0.3.0 (in the store) is the first flip, and the server hears it once', async ($, on) => {
    const w = world(on, { store: { enabled: false } })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toEqual({ on: false, rev: 1 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([false, 1])
    expect(w.beats().map(b => b.body)).toEqual([expect.objectContaining({ enabled: false, fishing: { on: false, rev: 1 } })])
    await w.clock.advance(120_000)
    expect(w.beats()).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe('🎣 off')
  })

  test("an older plugin's /fishing off or on in this install counts as one flip more", async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":true,"rev":3}\n' }, store: { enabled: true, switchRev: 3 } })
    await $.session.start(START)
    await w.clock.settle()
    w.store.set('enabled', false) // /fishing off in a session still on 0.2
    await w.clock.advance(5_000)
    expect(w.fishing()).toEqual({ on: false, rev: 4 })
    expect(w.store.get('switchRev')).toBe(4)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: false, fishing: { on: false, rev: 4 } }))
    w.store.set('enabled', true) // and /fishing on there
    await w.clock.advance(5_000)
    expect(w.fishing()).toEqual({ on: true, rev: 5 })
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, fishing: { on: true, rev: 5 } }))
  })

  test("a store stamped for an older flip follows the file (another install's, a hand-loaded copy's)", async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":false,"rev":5}\n' }, store: { enabled: true, switchRev: 2 } })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toEqual({ on: false, rev: 5 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([false, 5])
    expect(w.statuses.at(-1)).toBe('🎣 off')
  })

  test('a store never stamped follows the file too, once a flip has been made', async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":false,"rev":5}\n' }, store: { enabled: true } })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toEqual({ on: false, rev: 5 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([false, 5])
  })

  test('a newer switch from the server is taken: off, the session goes quiet without another word', async ($, on) => {
    const w = world(on)
    w.server.fishing = { on: false, rev: 4 } // the file was lost; the server kept the machine's switch
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toEqual({ on: false, rev: 4 })
    expect([w.store.get('enabled'), w.store.get('switchRev')]).toEqual([false, 4])
    expect(w.beats()).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe('🎣 off')
    await w.clock.advance(120_000)
    expect(w.beats()).toHaveLength(1)
  })

  test('an older switch from the server is not', async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":true,"rev":6}\n' } })
    w.server.fishing = { on: false, rev: 5 }
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fishing()).toEqual({ on: true, rev: 6 })
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('the same flip settled on by the server (an older plugin opened the game): taken, and the session resumes', async ($, on) => {
    const w = world(on, { files: { [FISHING_FILE]: '{"on":false,"rev":2}\n' } })
    w.server.fishing = { on: true, rev: 2 }
    await $.session.start(START)
    await w.clock.settle()
    expect(w.beats().map(b => b.body.enabled)).toEqual([false]) // the off, told at start, answered with the server's on
    expect(w.fishing()).toEqual({ on: true, rev: 2 })
    await w.clock.advance(5_000)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, fishing: { on: true, rev: 2 } }))
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('a switch file that does not read (half written, edited by hand) keeps the last switch', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    w.files.set(FISHING_FILE, '{"on":fal')
    await w.clock.advance(65_000)
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
    expect(w.lastBeat()).toEqual(expect.objectContaining({ enabled: true, fishing: { on: true, rev: 0 } }))
  })
})

describe('linking devices', () => {
  const SHARED: PlayerSummary = { name: 'Mochi', level: 9, rank: 'Deckhand', money: 340, totalCaught: 87 }
  const MINE: PlayerSummary = { name: 'Cat0042', level: 3, rank: 'Driftwood', money: 40, totalCaught: 12 }
  const FRESH: PlayerSummary = { name: 'Cat7781', level: 1, rank: 'Driftwood', money: 25, totalCaught: 0 }
  const linked = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: { ok: true, already: false, player: SHARED, previous: FRESH, machines: 2, windowSwitched: false, ...over },
  })
  const hasProgress = (afterwards = 'unlink') => ({ status: 200, body: { ok: false, error: 'has-progress', current: MINE, target: SHARED, afterwards } })
  const WARNING =
    'This machine already has progress: Cat0042 (level 3, 12 fish, $40). Linking switches it to Mochi (level 9, 87 fish, $340). ' +
    'Cat0042 stays saved: /fishing unlink switches this machine back to it. Switch this machine to Mochi?'

  test('link makes a one-time code, shows it in two groups and copies the command for the other device', async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link'] = () => ({ status: 200, body: { ok: true, code: 'KQ74MZ8P', expiresAt: 5_600_000, serverTime: 5_000_000, player: SHARED } })
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'link', ...TYPED })
    expect(w.to('/api/link')).toEqual([expect.objectContaining({ url: 'https://claudefishing.io/api/link', auth: `Bearer ${JSON.parse(w.files.get(IDENTITY)!).secret}` })])
    expect(w.copies).toEqual(['/fishing link KQ74-MZ8P'])
    expect(text).toBe(
      [
        'Link code KQ74-MZ8P: works once, for the next 10 min.',
        'On your other device, run /fishing link KQ74-MZ8P (copied)',
        'It then plays Mochi (level 9, 87 fish, $340) too: one cat, the same progress on both.',
      ].join('\n'),
    )
  })

  test('a machine that never opened the game has no cat to share yet', async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link'] = () => ({ status: 200, body: { ok: false, error: 'no-player' } })
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'link', ...TYPED })
    expect(text).toBe('This machine has no cat to share yet: /fishing open once, then /fishing link.')
    expect(w.copies).toEqual([])
  })

  test('a machine without progress links at once, as typed, and the status follows', async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link/claim'] = () => linked({ windowSwitched: true })
    await $.session.start(START)
    await w.clock.settle()
    const beats = w.beats().length
    const { text } = await $.command.run({ command: 'fishing', args: 'link kq74 mz8p', ...TYPED })
    expect(w.to('/api/link/claim').map(r => r.body)).toEqual([{ code: 'KQ74MZ8P', sessionId: 'sess-1', replace: false }])
    expect(w.asks).toEqual([])
    expect(text).toBe('Linked: this machine now plays Mochi (level 9, 87 fish, $340), on 2 devices.\nThe game window switched to it.')
    expect(w.beats()).toHaveLength(beats + 1)
  })

  test('a machine with progress is warned first; switching claims again with replace', async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link/claim'] = body => (body.replace === true ? linked({ previous: MINE }) : hasProgress())
    w.person.answer = 'Switch to Mochi'
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'fishing', args: 'link KQ74-MZ8P', ...TYPED })
    expect(w.asks).toEqual([{ question: WARNING, header: 'Link device', options: ['Switch to Mochi', 'Keep Cat0042'] }])
    expect(w.to('/api/link/claim').map(r => r.body.replace)).toEqual([false, true])
    expect(text).toBe(
      [
        'Linked: this machine now plays Mochi (level 9, 87 fish, $340), on 2 devices.',
        'Run /fishing open to play it here.',
        '/fishing unlink switches this machine back to its own cat.',
      ].join('\n'),
    )
  })

  test('keeping the cat, or dismissing the warning, links nothing', async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link/claim'] = body => (body.replace === true ? linked() : hasProgress())
    await $.session.start(START)
    for (const answer of ['Keep Cat0042', 'something typed under Other', null]) {
      w.person.answer = answer
      const { text } = await $.command.run({ command: 'fishing', args: 'link KQ74MZ8P', ...TYPED })
      expect(text).toBe('Not linked: this machine keeps Cat0042. The code works until it expires.')
    }
    expect(w.asks).toHaveLength(3)
    expect(w.to('/api/link/claim').map(r => r.body.replace)).toEqual([false, false, false])
  })

  test('the warning says when other devices keep the old cat, or when nothing would reach it again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    for (const afterwards of ['shared', 'lost']) {
      w.server.answers['/api/link/claim'] = () => hasProgress(afterwards)
      await $.command.run({ command: 'fishing', args: 'link KQ74MZ8P', ...TYPED })
    }
    expect(w.asks.map(a => a.question.split('. ')[2])).toEqual([
      'Cat0042 stays on the other devices that play it',
      'No other device plays Cat0042, so its progress could not be reached again',
    ])
  })

  test("the warning is the mod's own question: no activity, no buff, not waiting on the person", async ($, on) => {
    const w = world(on)
    w.server.answers['/api/link/claim'] = body => (body.replace === true ? linked({ previous: MINE }) : hasProgress())
    w.person.answer = 'Switch to Mochi'
    w.toolMs.AskUserQuestion = 30_000
    await $.session.start(START)
    await w.clock.settle()
    const run = $.command.run({ command: 'fishing', args: 'link KQ74MZ8P', ...TYPED })
    await w.clock.advance(30_000)
    await run
    await w.clock.settle()
    expect(w.lastBeat()).toEqual(expect.objectContaining({ working: false, activeAgoMs: null }))
    expect(w.state.get('turn')).toBeUndefined()
  })

  test('the same cat already, a wrong or used code, a busy network and an old server get plain answers', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const link = async () => (await $.command.run({ command: 'fishing', args: 'link KQ74MZ8P', ...TYPED })).text
    w.server.answers['/api/link/claim'] = () => linked({ already: true, previous: null })
    expect(await link()).toBe('This machine already plays Mochi (level 9, 87 fish, $340).')
    w.server.answers['/api/link/claim'] = () => ({ status: 400, body: { ok: false, error: 'invalid-code' } })
    expect(await link()).toBe('That code is wrong, expired or already used: run /fishing link on the other device for a new one.')
    w.server.answers['/api/link/claim'] = () => ({ status: 429, body: { ok: false, error: 'rate-limited' } })
    expect(await link()).toBe('Too many link attempts from this network: wait a few minutes, then try again.')
    w.server.answers['/api/link/claim'] = () => ({ status: 404, body: { ok: false, error: 'not-found' } })
    expect(await link()).toBe('The server at https://claudefishing.io cannot link devices yet (it needs an update).')
    w.server.down = true
    expect(await link()).toBe('server unreachable at https://claudefishing.io (connection refused)')
    w.server.down = false
    const claims = w.to('/api/link/claim').length
    const { text } = await $.command.run({ command: 'fishing', args: 'link hello', ...TYPED })
    expect(text).toBe('hello is not a link code: those are 8 letters and digits, like KQ74-MZ8P (/fishing link on the other device makes one).')
    expect(w.to('/api/link/claim')).toHaveLength(claims)
  })

  test('unlink returns to its own cat; leaving the last device of a cat with progress asks first', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const unlink = async () => (await $.command.run({ command: 'fishing', args: 'unlink', ...TYPED })).text
    w.server.answers['/api/unlink'] = () => ({ status: 200, body: { ok: false, error: 'not-linked' } })
    expect(await unlink()).toBe('This machine is not linked: it plays its own cat.')

    w.server.answers['/api/unlink'] = body =>
      body.confirm === true
        ? { status: 200, body: { ok: true, player: MINE, previous: SHARED, windowSwitched: true } }
        : { status: 200, body: { ok: false, error: 'last-device', current: SHARED } }
    w.person.answer = 'Stay linked'
    expect(await unlink()).toBe('Still linked: this machine plays Mochi.')
    w.person.answer = 'Unlink anyway'
    expect(await unlink()).toBe('Unlinked: this machine plays its own cat again, Cat0042 (level 3, 12 fish, $40).\nThe game window switched to it.')
    expect(w.asks.map(a => a.question)).toEqual([
      "No other device plays Mochi (level 9, 87 fish, $340): once this machine unlinks, its progress can't be reached again. Unlink anyway?",
      "No other device plays Mochi (level 9, 87 fish, $340): once this machine unlinks, its progress can't be reached again. Unlink anyway?",
    ])
    expect(w.to('/api/unlink').map(r => r.body)).toEqual([
      { sessionId: 'sess-1', confirm: false },
      { sessionId: 'sess-1', confirm: false },
      { sessionId: 'sess-1', confirm: false },
      { sessionId: 'sess-1', confirm: true },
    ])

    w.server.answers['/api/unlink'] = () => ({ status: 200, body: { ok: true, player: null, previous: SHARED, windowSwitched: false } })
    expect(await unlink()).toBe('Unlinked: this machine plays its own cat again, a new one, as it never had one.\nRun /fishing open to play it here.')
  })

  test('status lists the devices that play the cat', async ($, on) => {
    const w = world(on)
    w.server.machines = 3
    w.server.linked = true
    await $.session.start(START)
    const linkedText = (await $.command.run({ command: 'fishing', args: '', ...TYPED })).text
    expect(linkedText).toContain('\ndevices: 3 play Mochi, this one linked (/fishing unlink leaves)\nsessions: 1 live across 3 devices · ')
    w.server.linked = false
    const ownText = (await $.command.run({ command: 'fishing', args: 'status', ...TYPED })).text
    expect(ownText).toContain('\ndevices: 3 play Mochi (/fishing link adds another)\n')
  })
})

describe('auto-open', () => {
  test('session.attach from the desktop app pairs with reason auto, once', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.pairs()).toEqual([])
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await w.clock.settle()
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:2' })
    await w.clock.settle()
    expect(w.pairs()).toEqual([expect.objectContaining({ body: { sessionId: 'sess-1', reason: 'auto' } })])
    expect(w.argvs.filter(a => a[0] === 'open')).toEqual([['open', '-na', 'Google Chrome', '--args', '--app=https://claudefishing.io/#pair=K7Q2ZP']])
    expect(w.toasts).toEqual(['🎣 game opened in a Chrome app window'])
    expect(w.statuses.at(-1)).toBe('🎣 opening game')
  })

  test('VS Code attaching auto-opens too; a phone does not', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await w.clock.settle()
    expect(w.pairs()).toEqual([])
    await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
    await w.clock.settle()
    expect(w.pairs()).toEqual([expect.objectContaining({ body: { sessionId: 'sess-1', reason: 'auto' } })])
  })

  test('an interactive terminal session auto-opens after its first beat', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    expect(w.sent.map(s => s.url.replace('https://claudefishing.io', ''))).toEqual(['/api/heartbeat', '/api/pair'])
    expect(w.pairs()[0]?.body).toEqual({ sessionId: 'sess-1', reason: 'auto' })
    expect(w.state.get('autoOpen')).toBe('done')
  })

  test('a server unreachable at start: tried again on the first beat it answers, then never again', async ($, on) => {
    const w = world(on)
    w.server.down = true
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await w.clock.advance(40_000)
    expect(w.state.get('autoOpen')).toBe('pending')
    expect(w.argvs.filter(a => a[0] === 'open')).toEqual([])

    w.server.down = false
    await w.clock.advance(20_000)
    expect(w.pairs()).toEqual([expect.objectContaining({ body: { sessionId: 'sess-1', reason: 'auto' } })])
    expect(w.toasts).toEqual(['🎣 game opened in a Chrome app window'])
    expect(w.state.get('autoOpen')).toBe('done')

    await w.clock.advance(60_000)
    expect(w.pairs()).toHaveLength(1)
  })

  test('nothing opens when the server skips it, or autoOpen is off', { options: { autoOpen: false } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await w.clock.settle()
    expect(w.pairs()).toEqual([])
  })

  test('a skipped pair opens nothing and counts as done', async ($, on) => {
    const w = world(on)
    w.server.pair = { ok: false, skipped: 'client-connected' }
    await $.session.start(START)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await w.clock.settle()
    await w.clock.advance(60_000)
    expect(w.pairs()).toHaveLength(1)
    expect(w.argvs.filter(a => a[0] === 'open')).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.state.get('autoOpen')).toBe('done')
  })
})

describe('session end', () => {
  test('session.end sends ending:true, clears the status and stops beating', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-1', ending: true, working: false }))
    expect(w.statuses.at(-1)).toBe(undefined)
    const count = w.sent.length
    await w.clock.advance(60_000)
    expect(w.sent).toHaveLength(count)
  })

  test('an exit spends at most 0.6 s on a server that never answers', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    w.server.hang = true
    let isEnded = false
    const end = $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } }).then(() => {
      isEnded = true
    })
    await w.clock.advance(599)
    expect(isEnded).toBe(false)
    await w.clock.advance(1)
    await end
    expect(isEnded).toBe(true)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-1', ending: true }))
  })

  test('/clear beats as the new session id first, then ends the old one', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.settle()
    await w.clock.advance(5_000)
    const count = w.beats().length
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(w.beats()).toHaveLength(count) // nothing inside session.end
    await w.clock.settle()
    const after = w.beats().slice(count).map(s => s.body)
    expect(after).toHaveLength(2)
    expect(after[0]).toEqual(expect.objectContaining({ sessionId: 'sess-2', enabled: true, activeAgoMs: 5_000 }))
    expect(after[0]).not.toHaveProperty('ending')
    expect(after[1]).toEqual(expect.objectContaining({ sessionId: 'sess-1', ending: true }))

    await w.clock.advance(60_000)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-2' }))
    expect(w.beats().filter(s => s.body.sessionId === 'sess-1' && s.body.ending !== true)).toHaveLength(2)
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('/clear never waits on the server', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    w.server.hang = true
    let isEnded = false
    void $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } }).then(() => {
      isEnded = true
    })
    await w.clock.settle()
    expect(isEnded).toBe(true)
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-2' }))
    await w.clock.advance(4_000) // that beat gives up; then the old id is ended
    expect(w.lastBeat()).toEqual(expect.objectContaining({ sessionId: 'sess-1', ending: true }))
  })

  test('/clear when the engine moves to the new id only after session.end', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const count = w.beats().length
    w.session.next = null
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await w.clock.settle()
    expect(w.beats()).toHaveLength(count)
    w.session.id = 'sess-2'
    await w.clock.advance(50)
    const after = w.beats().slice(count).map(s => s.body)
    expect(after).toEqual([expect.objectContaining({ sessionId: 'sess-2' }), expect.objectContaining({ sessionId: 'sess-1', ending: true })])
  })

  test('/resume back to an earlier conversation beats as it again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await w.clock.settle()
    await w.clock.advance(60_000)

    w.session.next = 'sess-1'
    const count = w.beats().length
    await $.session.end({ reason: 'resume', sessionId: 'sess-2', resume: { id: 'sess-2' } })
    await w.clock.settle()
    const after = w.beats().slice(count).map(s => s.body)
    expect(after).toEqual([expect.objectContaining({ sessionId: 'sess-1' }), expect.objectContaining({ sessionId: 'sess-2', ending: true })])
    expect(after[0]).not.toHaveProperty('ending')

    await w.clock.advance(2 * 60_000 + 1_000) // two keepalives
    expect(w.beats().slice(count + 2).map(s => s.body.sessionId)).toEqual(Array(2).fill('sess-1'))
    expect(w.statuses.at(-1)).toBe('🎣 game closed')
  })

  test('/resume back to a conversation ended moments ago waits out the server tombstone before ending the other', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await w.clock.settle() // sess-1 ended at 1_000_000
    await w.clock.advance(2_000)

    w.session.next = 'sess-1'
    const count = w.beats().length
    await $.session.end({ reason: 'resume', sessionId: 'sess-2', resume: { id: 'sess-2' } })
    await w.clock.advance(8_000)
    expect(w.beats()).toHaveLength(count) // sess-2 stays live meanwhile
    await w.clock.advance(1_000)
    const after = w.beats().slice(count)
    expect(after.map(s => s.body)).toEqual([expect.objectContaining({ sessionId: 'sess-1' }), expect.objectContaining({ sessionId: 'sess-2', ending: true })])
    expect(after[0]?.at).toBe(1_010_500)
  })

  test('/clear resets the turn: the new conversation is not working', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await w.clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await w.clock.settle()
    expect(w.beats().find(s => s.body.sessionId === 'sess-2')?.body).toEqual(expect.objectContaining({ working: false }))
    expect(w.state.get('turn')).toEqual({ running: false, agents: [], waiting: false })
  })
})
