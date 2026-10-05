// claudefishing: connects this machine's Claude Code sessions to the
// claudefishing game. Heartbeats say a session is alive (so the game is
// playable), which model/effort it runs and whether Claude is working (the
// buff); /fishing opens the game, turns reporting on/off, shows status and
// links devices so they play one cat.

import type { EngineInterface, Register } from 'claude-code'
import { MOD_VERSION } from '../types/version'

import type { FishingActivity, FishingStep, FishingTurn } from '../types'
import type {
  HeartbeatRequest,
  HeartbeatResponse,
  LinkClaimRequest,
  LinkClaimResponse,
  LinkResponse,
  PairRequest,
  PairResponse,
  PlayerSummary,
  UnlinkRequest,
  UnlinkResponse,
} from '../types/protocol'

const DEFAULT_SERVER_URL = 'https://claudefishing.io' // npm run dev:sync swaps in the dev server in its copy only

/** Every change is sent at once (queueBeat); with none, the server still hears from the session this often. */
const KEEPALIVE_MS = 60_000
/** How often the session checks, without the network, whether a keepalive is due or a turn went stale. */
const TICK_MS = 5_000
/** After this session opens the game, every tick beats until the server sees the window join, for at most this long. */
const OPENING_MS = 45_000
const HTTP_TIMEOUT_MS = 4_000
/** /fishing off waits this long for a beat in flight, so its enabled:false lands after it. */
const OFF_INFLIGHT_WAIT_MS = 300
/** session.end has ~1.5 s for the whole chain: an exit spends at most this telling the server (its TTL drops the session anyway). */
const END_TIMEOUT_MS = 600
/** A beat already under way for a session id that just ended is dropped for this long; a later return to the id (/resume) beats again. */
const ENDED_GUARD_MS = 5_000
/** Mirrors the server's ENDED_TOMBSTONE_MS: it ignores beats for an id this long after that id ended. */
const SERVER_TOMBSTONE_MS = 10_000
/** After a /clear or /resume the engine may move to the next conversation's id a moment after session.end: poll for it. */
const SWITCH_POLL_MS = 50
const SWITCH_POLLS = 40
/** Mirrors the server's buff.inactivityMs: activity after this long idle beats at once. */
const INACTIVE_MS = 5 * 60_000
/** A turn with no step or tool call for this long counts as over (its end was never seen); long tool runs stay inside it. */
const STALE_TURN_MS = 30 * 60_000
/** Notification types that mean a prompt or dialog waits on the person. */
const PROMPT_NOTIFICATION = /permission_prompt|idle_prompt|elicitation(_url)?_dialog|needs_input/
/** Tools whose call lasts until the person answers. */
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode'])
const USAGE = 'usage: /fishing [status|open|on|off|link [code]|unlink]'

// Session-scoped values that survive hot reloads (module variables do not).
const ACTIVITY = { plugin: 'claudefishing', key: 'activity' } as const
const TURN = { plugin: 'claudefishing', key: 'turn' } as const
const AUTO_OPEN = { plugin: 'claudefishing', key: 'autoOpen' } as const

type Identity = { secret: string; createdAt: number }

type Link = 'unknown' | 'online' | 'offline'

/** `status` is set when the server answered with an HTTP error, absent when it could not be reached; `code` is the error the answer named. */
type Reply = { ok: true; json: unknown } | { ok: false; error: string; status?: number; code?: string }

type Runtime = {
  serverUrl: string
  autoOpen: boolean
  /** /fishing on|off, shared by every session on the machine through $.store. */
  enabled: boolean
  identityPath: string | null
  identity: Identity | null
  identityError: string | null
  /** The one load (or creation) of the identity, shared by every caller while it runs. */
  identityLoad: Promise<Identity | null> | null
  /** Set when an unreadable identity file was moved aside. */
  identityNote: string | null
  activity: FishingActivity
  turn: FishingTurn
  lastSentWorking: boolean | null
  /** When this session last sent a heartbeat: the next keepalive is due KEEPALIVE_MS after it. */
  lastBeatAt: number | null
  /** The plugin version an update toast was shown for (once each). */
  updateToastFor: string | null
  link: Link
  linkError: string | null
  last: HeartbeatResponse | null
  timer: { cancel: () => void } | null
  isBeatQueued: boolean
  inFlight: Promise<Reply> | null
  /** Beats are numbered so a late answer never overwrites a newer one. */
  sentSeq: number
  appliedSeq: number
  isAutoOpening: boolean
  /** The auto-open could not reach the server: the next beat it answers tries again. */
  isAutoOpenPending: boolean
  /** Until when a window this session opened is awaited (null: none): the line says "opening game" meanwhile. */
  openingUntil: number | null
  /** Session ids this process told the server were over, and when. */
  endedAt: Map<string, number>
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function errorText(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split('\n')[0]!
  if (text.includes('ECONNREFUSED')) return 'connection refused'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(text)) return 'host not found'
  return text.replace(/^claudefishing: \$\.[\w.]+(?:\(.*?\))?(?: failed)?: /, '').slice(0, 160)
}

// Waiting on the person (a permission prompt, a question) is not working, however long the turn stays open.
function isWorking(rt: Runtime, now: number): boolean {
  if (rt.turn.waiting || (!rt.turn.running && rt.turn.agents.length === 0)) return false
  const last = rt.activity.lastActiveAt
  return last !== null && now - last < STALE_TURN_MS
}

function isRecentlyEnded(rt: Runtime, sessionId: string, now: number): boolean {
  const endedAt = rt.endedAt.get(sessionId)
  return endedAt !== undefined && now - endedAt < ENDED_GUARD_MS
}

function markEnded(rt: Runtime, sessionId: string, now: number): void {
  // An end older than a minute matters to nobody: the guard and the server's tombstone are seconds long.
  for (const [id, at] of rt.endedAt) if (now - at > 60_000) rt.endedAt.delete(id)
  rt.endedAt.set(sessionId, now)
}

function pct(fraction: number): string {
  return `+${Math.round(fraction * 100)}%`
}

function statusLine(rt: Runtime): string | undefined {
  if (!rt.enabled) return '🎣 off'
  if (rt.link === 'unknown') return undefined
  if (rt.link === 'offline' || rt.last === null) return '🎣 offline'
  if (rt.last.modUpdate?.required === true) return '🎣 update the plugin to play (/fishing status)'
  const base = rt.last.clientConnected ? '🎣 in game' : rt.openingUntil !== null ? '🎣 opening game' : '🎣 game closed'
  const { buff } = rt.last.presence
  const update = rt.last.modUpdate ? ' · update available' : ''
  return buff.active ? `${base} · ⚡${pct(buff.pct)}${update}` : `${base}${update}`
}

function asHeartbeatResponse(json: unknown): HeartbeatResponse | null {
  const res = json as Partial<HeartbeatResponse> | null
  if (res === null || typeof res !== 'object' || res.ok !== true) return null
  const presence = res.presence
  if (typeof presence !== 'object' || presence === null || typeof presence.buff !== 'object' || presence.buff === null) return null
  return res as HeartbeatResponse
}

// ─── identity ──────────────────────────────────────────────────────────────

async function identityPath($: EngineInterface): Promise<string> {
  // $.fs does not expand "~" (it resolves against the session cwd): build it from HOME.
  const override = await $.env.get('CLAUDEFISHING_HOME')
  if (override) return `${override.replace(/\/+$/, '')}/identity.json`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return `${home}/.claudefishing/identity.json`
}

function parseIdentity(text: string): Identity | null {
  try {
    const parsed = JSON.parse(text) as Partial<Identity>
    if (typeof parsed.secret === 'string' && /^[0-9a-f]{64}$/.test(parsed.secret)) {
      return { secret: parsed.secret, createdAt: Number(parsed.createdAt) || 0 }
    }
  } catch {
    // corrupt
  }
  return null
}

async function readIdentity($: EngineInterface, path: string): Promise<Identity | 'missing' | 'corrupt'> {
  if (!(await $.fs.exists(path))) return 'missing'
  return parseIdentity(await $.fs.read(path)) ?? 'corrupt'
}

// Never leaves a half-written identity.json, and never replaces one: other sessions may be minting at the same moment.
async function createIdentity($: EngineInterface, path: string): Promise<void> {
  const identity: Identity = { secret: hex(crypto.getRandomValues(new Uint8Array(32))), createdAt: await $.clock.now() }
  const text = `${JSON.stringify(identity, null, 2)}\n`
  const tmp = `${path}.${hex(crypto.getRandomValues(new Uint8Array(6)))}.tmp`
  await $.fs.write(tmp, text)
  await $.process.run(['chmod', '600', tmp]).catch(() => undefined) // $.fs has no chmod
  // link(2) fails when identity.json exists: of two sessions minting at once the first link wins, and both read it back.
  const linked = await $.process.run(['ln', tmp, path]).catch(() => null)
  await $.process.run(['rm', '-f', tmp]).catch(() => undefined)
  if (linked === null && !(await $.fs.exists(path))) await $.fs.write(path, text) // no ln on this system
}

async function loadIdentity($: EngineInterface, rt: Runtime, path: string): Promise<Identity> {
  const existing = await readIdentity($, path)
  if (typeof existing === 'object') return existing
  // An owner-only folder first, so the secret is never readable by others, even before its chmod.
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (dir !== '') await $.process.run(['mkdir', '-p', '-m', '700', dir]).catch(() => undefined)
  if (existing === 'corrupt') {
    // Moved aside, not overwritten: it may still hold a secret worth recovering by hand.
    const aside = `${path}.corrupt-${await $.clock.now()}`
    const moved = await $.process.run(['mv', path, aside]).catch(() => null)
    if (moved?.exitCode === 0) rt.identityNote = `the unreadable one was kept as ${aside}`
  }
  await createIdentity($, path)
  const created = await readIdentity($, path)
  if (typeof created === 'object') return created
  throw new Error(`could not create ${path}`)
}

async function loadIdentitySafely($: EngineInterface, rt: Runtime): Promise<Identity | null> {
  try {
    rt.identityPath ??= await identityPath($)
    rt.identity = await loadIdentity($, rt, rt.identityPath)
    rt.identityError = null
  } catch (err) {
    rt.identityError = errorText(err)
    rt.identityLoad = null // the next caller tries again
  }
  return rt.identity
}

function ensureIdentity($: EngineInterface, rt: Runtime): Promise<Identity | null> {
  rt.identityLoad ??= loadIdentitySafely($, rt)
  return rt.identityLoad
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

// $.http.fetch has no timeout or signal: race it against $.clock.sleep (the fetch is abandoned, not aborted).
async function postJson($: EngineInterface, rt: Runtime, path: string, secret: string, body: unknown, timeoutMs: number): Promise<Reply> {
  const request = $.http
    .fetch(`${rt.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    })
    .then(
      (res): Reply => {
        let json: unknown
        try {
          json = JSON.parse(res.text)
        } catch {
          return { ok: false, error: res.ok ? 'the answer was not JSON' : `HTTP ${res.status}`, status: res.status }
        }
        if (res.ok) return { ok: true, json }
        const code = (json as { error?: unknown } | null)?.error
        if (typeof code !== 'string') return { ok: false, error: `HTTP ${res.status}`, status: res.status }
        return { ok: false, error: `HTTP ${res.status} ${code}`, status: res.status, code }
      },
      (err: unknown): Reply => ({ ok: false, error: errorText(err) }),
    )
  const timeout = $.clock.sleep(timeoutMs).then((): Reply => ({ ok: false, error: `no answer within ${timeoutMs / 1000} s` }))
  return Promise.race([request, timeout])
}

// ─── heartbeats ────────────────────────────────────────────────────────────

async function heartbeatBody($: EngineInterface, rt: Runtime, sessionId: string, now: number): Promise<HeartbeatRequest> {
  const step = rt.activity.step
  const lastActiveAt = rt.activity.lastActiveAt
  return {
    sessionId,
    enabled: rt.enabled,
    model: step?.model ?? (await $.session.model().catch(() => null)),
    // Effort is only known from a real request (absent on models without effort), so it is
    // null until this session's first turn; the buff only exists after a turn anyway.
    effort: step?.effort ?? null,
    working: isWorking(rt, now),
    activeAgoMs: lastActiveAt === null ? null : Math.max(0, now - lastActiveAt),
    modVersion: MOD_VERSION,
  }
}

function applyReply(rt: Runtime, reply: Reply): void {
  const res = reply.ok ? asHeartbeatResponse(reply.json) : null
  rt.link = res !== null ? 'online' : 'offline'
  rt.linkError = res !== null ? null : reply.ok ? 'unexpected answer' : reply.error
  rt.last = res ?? rt.last
  if (res?.clientConnected === true) rt.openingUntil = null // the awaited window joined
}

async function beat($: EngineInterface, rt: Runtime): Promise<void> {
  // /fishing on|off may have run in another session on this machine.
  const enabled = (await $.store.get('enabled')) !== false
  if (!enabled) {
    if (rt.enabled) await turnOff($, rt)
    $.ui.status('🎣 off')
    return
  }
  rt.enabled = true
  const sessionId = await $.session.id()
  const identity = await ensureIdentity($, rt)
  if (identity === null) {
    rt.link = 'offline'
    rt.linkError = `no identity: ${rt.identityError}`
    $.ui.status(statusLine(rt))
    return
  }
  const now = await $.clock.now()
  const body = await heartbeatBody($, rt, sessionId, now)
  if (isRecentlyEnded(rt, sessionId, now) || !rt.enabled) return // session.end or /fishing off ran meanwhile
  rt.lastSentWorking = body.working
  rt.lastBeatAt = now
  const seq = ++rt.sentSeq
  const request = postJson($, rt, '/api/heartbeat', identity.secret, body, HTTP_TIMEOUT_MS)
  rt.inFlight = request
  const reply = await request
  if (rt.inFlight === request) rt.inFlight = null
  if (seq < rt.appliedSeq || !rt.enabled) return
  rt.appliedSeq = seq
  applyReply(rt, reply)
  $.ui.status(statusLine(rt))
  toastUpdate($, rt)
  if (rt.isAutoOpenPending && rt.link === 'online') void autoOpenSafely($, rt)
}

/** Once per newer plugin, a toast with the command that updates this one. */
function toastUpdate($: EngineInterface, rt: Runtime): void {
  const update = rt.link === 'online' ? rt.last?.modUpdate : null
  if (!update || rt.updateToastFor === update.latest) return
  rt.updateToastFor = update.latest
  const why = update.required ? `the game needs ${update.min ?? update.latest} or newer` : `${update.latest} is out`
  $.ui.toast(`🎣 claudefishing ${MOD_VERSION}: ${why}. Update in a terminal: ${update.command}`)
}

async function runBeat($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    await beat($, rt)
  } catch (err) {
    rt.link = 'offline'
    rt.linkError = errorText(err)
    $.ui.status(statusLine(rt))
  }
}

// Beat as soon as this dispatch is over (a timer runs outside the hook's budget); one queued at a time.
function queueBeat($: EngineInterface, rt: Runtime): void {
  if (rt.isBeatQueued) return
  rt.isBeatQueued = true
  $.clock.after(0, () => {
    rt.isBeatQueued = false
    void runBeat($, rt)
  })
}

// A keepalive once the server has heard nothing for KEEPALIVE_MS, a beat as soon as a turn goes
// stale (STALE_TURN_MS) and stops counting as work, and one every tick while a window this session
// opened has not joined (the server only says so in a beat's answer): time alone changes nothing else.
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  if (rt.openingUntil !== null && now >= rt.openingUntil) {
    rt.openingUntil = null // it never joined: "game closed" again, and keepalives only
    $.ui.status(statusLine(rt))
  }
  const isStale = rt.lastSentWorking === true && !isWorking(rt, now)
  if (rt.openingUntil === null && !isStale && rt.lastBeatAt !== null && now - rt.lastBeatAt < KEEPALIVE_MS) return
  // Counted as a beat even if it cannot be sent (offline, fishing off): the next try is a keepalive later.
  rt.lastBeatAt = now
  await runBeat($, rt)
}

function startTimer($: EngineInterface, rt: Runtime): void {
  rt.timer?.cancel()
  // Keeps ticking while off too (no network then) so a /fishing on from another session resumes this one.
  rt.timer = $.clock.every(TICK_MS, () => void tick($, rt))
}

// The store is what every beat reads, this machine's other sessions' included.
async function turnOn($: EngineInterface, rt: Runtime): Promise<void> {
  await $.store.set('enabled', true)
  rt.enabled = true
  startTimer($, rt)
  await runBeat($, rt)
}

// Tell the server to drop this session now rather than after its TTL.
async function turnOff($: EngineInterface, rt: Runtime): Promise<void> {
  rt.enabled = false
  rt.lastSentWorking = null
  rt.openingUntil = null
  if (rt.inFlight !== null) await Promise.race([rt.inFlight, $.clock.sleep(OFF_INFLIGHT_WAIT_MS)]) // land it first
  const identity = rt.identity
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (identity !== null && !isRecentlyEnded(rt, sessionId, now)) {
    const body = await heartbeatBody($, rt, sessionId, now)
    await postJson($, rt, '/api/heartbeat', identity.secret, { ...body, enabled: false }, HTTP_TIMEOUT_MS)
  }
  rt.link = 'unknown'
  rt.last = null
}

async function sendEnding($: EngineInterface, rt: Runtime, sessionId: string, timeoutMs: number): Promise<void> {
  const now = await $.clock.now()
  markEnded(rt, sessionId, now)
  const identity = rt.identity
  if (!rt.enabled || identity === null) return
  const body = await heartbeatBody($, rt, sessionId, now)
  await postJson($, rt, '/api/heartbeat', identity.secret, { ...body, working: false, ending: true }, timeoutMs)
}

// After a /clear or an in-session /resume the process goes on as another conversation: beat as it
// first, then end the old id, so the server never sees this machine without a session.
async function switchSession($: EngineInterface, rt: Runtime, endedId: string): Promise<void> {
  let sessionId = await $.session.id()
  for (let i = 0; sessionId === endedId && i < SWITCH_POLLS; i++) {
    await $.clock.sleep(SWITCH_POLL_MS)
    sessionId = await $.session.id()
  }
  if (sessionId === endedId) return runBeat($, rt) // still the same conversation: nothing to end
  const endedAt = rt.endedAt.get(sessionId)
  if (endedAt !== undefined) {
    // Back to a conversation ended moments ago: the server ignores its beats until its tombstone passes.
    const wait = endedAt + SERVER_TOMBSTONE_MS + 500 - (await $.clock.now())
    if (wait > 0) await $.clock.sleep(wait)
    rt.endedAt.delete(sessionId)
  }
  await runBeat($, rt)
  await sendEnding($, rt, endedId, HTTP_TIMEOUT_MS)
}

async function switchSessionSafely($: EngineInterface, rt: Runtime, endedId: string): Promise<void> {
  try {
    await switchSession($, rt, endedId)
  } catch {
    // the timer beats as the new id; the server's TTL drops the old one
  }
}

// Every sign of Claude going on: stamps the activity and ends any wait on the person.
async function touch($: EngineInterface, rt: Runtime, turn: Partial<FishingTurn> = {}, step?: FishingStep): Promise<void> {
  const turnBefore = rt.turn
  rt.turn = { ...turnBefore, waiting: false, ...turn }
  const isTurnChanged = rt.turn.running !== turnBefore.running || rt.turn.waiting !== turnBefore.waiting || rt.turn.agents !== turnBefore.agents
  const now = await $.clock.now()
  const before = rt.activity
  const wasInactive = before.lastActiveAt === null || now - before.lastActiveAt >= INACTIVE_MS
  const isStepChanged = step !== undefined && (before.step?.model !== step.model || before.step?.effort !== step.effort)
  rt.activity = { lastActiveAt: now, step: step ?? before.step }
  await $.state.set(ACTIVITY, rt.activity)
  if (isTurnChanged) await $.state.set(TURN, rt.turn)
  if (rt.enabled && (wasInactive || isStepChanged || isWorking(rt, now) !== rt.lastSentWorking)) queueBeat($, rt)
}

// Hooks on the turn's path must never fail because of the game.
async function touchSafely($: EngineInterface, rt: Runtime, turn?: Partial<FishingTurn>, step?: FishingStep): Promise<void> {
  try {
    await touch($, rt, turn, step)
  } catch {
    // the next timer beat carries whatever this missed
  }
}

// Waiting stamps no activity: the buff runs out 5 minutes after Claude last did something.
async function setWaiting($: EngineInterface, rt: Runtime, waiting: boolean): Promise<void> {
  if (rt.turn.waiting === waiting) return
  rt.turn = { ...rt.turn, waiting }
  await $.state.set(TURN, rt.turn)
  if (rt.enabled && isWorking(rt, await $.clock.now()) !== rt.lastSentWorking) queueBeat($, rt)
}

async function setWaitingSafely($: EngineInterface, rt: Runtime, waiting: boolean): Promise<void> {
  try {
    await setWaiting($, rt, waiting)
  } catch {
    // the next timer beat carries it
  }
}

// The last step's effort belongs to the old model: unknown until the new one runs a step.
async function switchModel($: EngineInterface, rt: Runtime, model: string): Promise<void> {
  rt.activity = { ...rt.activity, step: { model, effort: null } }
  await $.state.set(ACTIVITY, rt.activity)
  if (rt.enabled) queueBeat($, rt)
}

async function switchModelSafely($: EngineInterface, rt: Runtime, model: string): Promise<void> {
  try {
    await switchModel($, rt, model)
  } catch {
    // the next step reports the model
  }
}

// ─── opening the game ──────────────────────────────────────────────────────

async function openUrl($: EngineInterface, url: string): Promise<string | null> {
  // macOS: -n so --args reach a Chrome that is already running; then the default browser.
  const tries: [argv: string[], how: string][] = [
    [['open', '-na', 'Google Chrome', '--args', `--app=${url}`], 'a Chrome app window'],
    [['open', url], 'the default browser'],
    [['xdg-open', url], 'the default browser'],
  ]
  for (const [argv, how] of tries) {
    const result = await $.process.run(argv).catch(() => null)
    if (result?.exitCode === 0) return how
  }
  return null
}

/** unreachable: the pair request got no answer at all (worth trying again); failed: anything else that went wrong. */
type OpenResult = { kind: 'opened' | 'skipped' | 'failed' | 'unreachable'; text: string }

async function openGame($: EngineInterface, rt: Runtime, reason: PairRequest['reason']): Promise<OpenResult> {
  const identity = await ensureIdentity($, rt)
  if (identity === null) return { kind: 'failed', text: `no identity file: ${rt.identityError}` }
  const request: PairRequest = { sessionId: await $.session.id(), reason }
  const reply = await postJson($, rt, '/api/pair', identity.secret, request, HTTP_TIMEOUT_MS)
  if (!reply.ok) {
    return { kind: reply.status === undefined ? 'unreachable' : 'failed', text: `server unreachable at ${rt.serverUrl} (${reply.error})` }
  }
  const pair = reply.json as PairResponse | null
  if (pair === null || typeof pair !== 'object') return { kind: 'failed', text: 'unexpected answer from the server' }
  if (pair.ok === false) {
    return { kind: 'skipped', text: pair.skipped === 'client-connected' ? 'the game is already open' : 'the game was opened moments ago' }
  }
  if (typeof pair.code !== 'string') return { kind: 'failed', text: 'unexpected answer from the server' }
  const url = `${rt.serverUrl}/#pair=${encodeURIComponent(pair.code)}`
  const how = await openUrl($, url)
  if (how === null) return { kind: 'failed', text: `could not start a browser; open ${url} yourself (the link works once, for 2 minutes)` }
  // The window takes a few seconds to load and join: until a beat's answer says it did, the line says so.
  rt.openingUntil = (await $.clock.now()) + OPENING_MS
  $.ui.status(statusLine(rt))
  return { kind: 'opened', text: `opened in ${how}` }
}

// Once per session (the terminal at start, the desktop app or VS Code when it attaches); done once the
// server answered the pair, even with a skip. One it could not reach is tried again on a later beat.
async function autoOpen($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.autoOpen || !rt.enabled || rt.isAutoOpening) return
  rt.isAutoOpening = true
  try {
    const { value: state } = await $.state.get(AUTO_OPEN)
    if (state === 'done') {
      rt.isAutoOpenPending = false
      return
    }
    const result = await openGame($, rt, 'auto')
    rt.isAutoOpenPending = result.kind === 'unreachable'
    await $.state.set(AUTO_OPEN, rt.isAutoOpenPending ? 'pending' : 'done')
    if (result.kind === 'opened') $.ui.toast(`🎣 game ${result.text}`)
  } finally {
    rt.isAutoOpening = false
  }
}

async function autoOpenSafely($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    await autoOpen($, rt)
  } catch {
    // /fishing open is always there
  }
}

// ─── /fishing ──────────────────────────────────────────────────────────────

function buffText(res: HeartbeatResponse): string {
  const { buff, working } = res.presence
  if (!buff.active) return `off (Claude idle; ${pct(buff.potentialPct)} while working)`
  if (working || buff.expiresAt === null) return `⚡${pct(buff.pct)} while Claude works`
  const minutes = Math.max(1, Math.ceil((buff.expiresAt - res.serverTime) / 60_000))
  return `⚡${pct(buff.pct)}, ${minutes} min left`
}

// Older servers send neither field: one machine, its own cat.
function devicesText(res: HeartbeatResponse, cat: PlayerSummary): string {
  const machines = typeof res.machines === 'number' ? res.machines : 1
  if (res.linked === true) return `${machines} play ${cat.name}, this one linked (/fishing unlink leaves)`
  if (machines > 1) return `${machines} play ${cat.name} (/fishing link adds another)`
  return `this one only (/fishing link plays ${cat.name} on another too)`
}

async function statusReport($: EngineInterface, rt: Runtime): Promise<string> {
  const now = await $.clock.now()
  const body = await heartbeatBody($, rt, await $.session.id(), now)
  const link = rt.link === 'online' ? 'online' : rt.link === 'offline' ? `offline (${rt.linkError ?? 'no answer'})` : 'not connected'
  const lines = [`fishing ${rt.enabled ? 'on' : 'off'} · server ${rt.serverUrl} · ${rt.enabled ? link : 'not reporting'}`]
  const res = rt.enabled && rt.link === 'online' ? rt.last : null
  if (res !== null) {
    const update = res.modUpdate
    if (update) {
      const why = update.required ? `the game needs ${update.min ?? update.latest} or newer` : `${update.latest} is out`
      lines.push(`plugin: ${MOD_VERSION}, ${why}. Update in a terminal, then restart Claude Code: ${update.command}`)
    }
    lines.push(`game: ${res.clientConnected ? 'in game' : rt.openingUntil !== null ? 'opening' : 'closed (/fishing open)'}`)
    if (res.player !== null) {
      lines.push(`player: ${res.player.name} · level ${res.player.level} ${res.player.rank} · $${res.player.money}`)
      lines.push(`devices: ${devicesText(res, res.player)}`)
    }
    const where = res.machines > 1 ? `across ${res.machines} devices` : 'on this machine'
    lines.push(`sessions: ${res.presence.sessionCount} live ${where} · shown as ${res.presence.model ?? 'unknown'}${res.presence.effort ? ` · ${res.presence.effort}` : ''}`)
    lines.push(`buff: ${buffText(res)}`)
  }
  const doing = body.working ? ' · working' : rt.turn.waiting ? ' · waiting on you' : ''
  lines.push(`this session: model ${body.model ?? 'unknown'} · effort ${body.effort ?? 'not known until a turn runs'}${doing}`)
  const note = rt.identityNote === null ? '' : `; ${rt.identityNote}`
  lines.push(`identity: ${rt.identityPath ?? (await identityPath($))} (stays on this machine${note})`)
  lines.push(USAGE)
  return lines.join('\n')
}

// ─── linking devices ───────────────────────────────────────────────────────
// Every machine has its own cat until it claims a link code from a machine
// that plays another: from then on both play that one (one cat, one
// progress). /fishing unlink returns a machine to its own cat.

type HasProgress = Extract<LinkClaimResponse, { error: 'has-progress' }>

/** "Mochi (level 3, 12 fish, $120)" */
function catText(cat: PlayerSummary): string {
  return `${cat.name} (level ${cat.level}, ${cat.totalCaught} fish, $${cat.money})`
}

/** Shown as two groups of four; the server reads it back in any case, with or without spaces and dashes. */
function showCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** A link request that got no answer to act on. */
function linkFailure(rt: Runtime, reply: Extract<Reply, { ok: false }>): string {
  if (reply.status === undefined) return `server unreachable at ${rt.serverUrl} (${reply.error})`
  if (reply.code === 'invalid-code') return 'That code is wrong, expired or already used: run /fishing link on the other device for a new one.'
  if (reply.status === 429) return 'Too many link attempts from this network: wait a few minutes, then try again.'
  if (reply.status === 404) return `The server at ${rt.serverUrl} cannot link devices yet (it needs an update).`
  return `linking failed (${reply.error})`
}

/** The label picked, or null when the question was dismissed or nobody could be asked (`claude -p`). */
async function choose($: EngineInterface, question: string, options: [yes: string, no: string]): Promise<string | null> {
  try {
    return await $.ui.ask(question, { header: 'Link device', options })
  } catch {
    return null
  }
}

/** The warning before a machine with progress switches cats, and the two answers (switch first). */
function switchQuestion({ current, target, afterwards }: HasProgress): { question: string; options: [yes: string, no: string] } {
  const fate = {
    unlink: `${current.name} stays saved: /fishing unlink switches this machine back to it.`,
    shared: `${current.name} stays on the other devices that play it.`,
    lost: `No other device plays ${current.name}, so its progress could not be reached again.`,
  }[afterwards]
  const isSameName = current.name === target.name
  return {
    question: `This machine already has progress: ${catText(current)}. Linking switches it to ${catText(target)}. ${fate} Switch this machine to ${target.name}?`,
    options: isSameName ? ['Switch cats', 'Keep this one'] : [`Switch to ${target.name}`, `Keep ${current.name}`],
  }
}

// The heartbeat answer (status line, /fishing status) follows the switch at once.
async function refresh($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.enabled) await runBeat($, rt)
}

async function createLink($: EngineInterface, rt: Runtime): Promise<string> {
  const identity = await ensureIdentity($, rt)
  if (identity === null) return `no identity file: ${rt.identityError}`
  const reply = await postJson($, rt, '/api/link', identity.secret, {}, HTTP_TIMEOUT_MS)
  if (!reply.ok) return linkFailure(rt, reply)
  const res = reply.json as LinkResponse | null
  if (res?.ok === false && res.error === 'no-player') return 'This machine has no cat to share yet: /fishing open once, then /fishing link.'
  if (res?.ok !== true || typeof res.code !== 'string' || typeof res.player !== 'object') return 'unexpected answer from the server'
  const command = `/fishing link ${showCode(res.code)}`
  const copied = (await $.ui.copy({ text: command }).catch(() => null))?.isCopied === true
  const minutes = Math.max(1, Math.round((res.expiresAt - res.serverTime) / 60_000))
  return [
    `Link code ${showCode(res.code)}: works once, for the next ${minutes} min.`,
    `On your other device, run ${command}${copied ? ' (copied)' : ''}`,
    `It then plays ${catText(res.player)} too: one cat, the same progress on both.`,
  ].join('\n')
}

async function claimLink($: EngineInterface, rt: Runtime, typed: string): Promise<string> {
  const code = typed.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[0-9A-Z]{8}$/.test(code)) return `${typed} is not a link code: those are 8 letters and digits, like KQ74-MZ8P (/fishing link on the other device makes one).`
  const identity = await ensureIdentity($, rt)
  if (identity === null) return `no identity file: ${rt.identityError}`
  const sessionId = await $.session.id()
  const claim = (replace: boolean) =>
    postJson($, rt, '/api/link/claim', identity.secret, { code, sessionId, replace } satisfies LinkClaimRequest, HTTP_TIMEOUT_MS)
  let reply = await claim(false)
  const first = reply.ok ? (reply.json as LinkClaimResponse | null) : null
  if (first?.ok === false && first.error === 'has-progress') {
    const { question, options } = switchQuestion(first)
    if ((await choose($, question, options)) !== options[0]) return `Not linked: this machine keeps ${first.current.name}. The code works until it expires.`
    reply = await claim(true)
  }
  if (!reply.ok) return linkFailure(rt, reply)
  const res = reply.json as LinkClaimResponse | null
  if (res?.ok !== true || typeof res.player !== 'object') return 'unexpected answer from the server'
  if (res.already) return `This machine already plays ${catText(res.player)}.`
  await refresh($, rt)
  const lines = [`Linked: this machine now plays ${catText(res.player)}, on ${res.machines} devices.`]
  lines.push(res.windowSwitched ? 'The game window switched to it.' : 'Run /fishing open to play it here.')
  if (res.previous !== null && res.previous.totalCaught > 0) lines.push(`/fishing unlink switches this machine back to its own cat.`)
  return lines.join('\n')
}

async function unlinkMachine($: EngineInterface, rt: Runtime): Promise<string> {
  const identity = await ensureIdentity($, rt)
  if (identity === null) return `no identity file: ${rt.identityError}`
  const sessionId = await $.session.id()
  const unlink = (confirm: boolean) => postJson($, rt, '/api/unlink', identity.secret, { sessionId, confirm } satisfies UnlinkRequest, HTTP_TIMEOUT_MS)
  let reply = await unlink(false)
  const first = reply.ok ? (reply.json as UnlinkResponse | null) : null
  if (first?.ok === false && first.error === 'not-linked') return 'This machine is not linked: it plays its own cat.'
  if (first?.ok === false && first.error === 'last-device') {
    const question = `No other device plays ${catText(first.current)}: once this machine unlinks, its progress can't be reached again. Unlink anyway?`
    const options: [string, string] = ['Unlink anyway', 'Stay linked']
    if ((await choose($, question, options)) !== options[0]) return `Still linked: this machine plays ${first.current.name}.`
    reply = await unlink(true)
  }
  if (!reply.ok) return linkFailure(rt, reply)
  const res = reply.json as UnlinkResponse | null
  if (res?.ok !== true) return 'unexpected answer from the server'
  await refresh($, rt)
  const own = res.player === null ? 'a new one, as it never had one' : catText(res.player)
  const lines = [`Unlinked: this machine plays its own cat again, ${own}.`]
  lines.push(res.windowSwitched ? 'The game window switched to it.' : 'Run /fishing open to play it here.')
  return lines.join('\n')
}

// ─── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt: Runtime = {
    serverUrl: (typeof options.serverUrl === 'string' && options.serverUrl.trim() !== '' ? options.serverUrl.trim() : DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    autoOpen: options.autoOpen !== false,
    enabled: true,
    identityPath: null,
    identity: null,
    identityError: null,
    identityLoad: null,
    identityNote: null,
    activity: { lastActiveAt: null, step: null },
    turn: { running: false, agents: [], waiting: false },
    lastSentWorking: null,
    lastBeatAt: null,
    updateToastFor: null,
    link: 'unknown',
    linkError: null,
    last: null,
    timer: null,
    isBeatQueued: false,
    inFlight: null,
    sentSeq: 0,
    appliedSeq: 0,
    isAutoOpening: false,
    isAutoOpenPending: false,
    openingUntil: null,
    endedAt: new Map(),
  }

  // Also runs on every hot reload (module variables reset; $.state and $.store persist).
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fishing',
      description: 'claudefishing: status | open | on | off | link | unlink',
      argumentHint: '[status|open|on|off|link [code]|unlink]',
    })
    rt.enabled = (await $.store.get('enabled')) !== false
    const { value: activity } = await $.state.get(ACTIVITY)
    if (activity !== undefined) rt.activity = activity
    // A reload mid-turn keeps the turn, its subagents and a prompt waiting on the person.
    const { value: turn } = await $.state.get(TURN)
    if (turn !== undefined) rt.turn = turn
    const { value: autoOpenState } = await $.state.get(AUTO_OPEN)
    rt.isAutoOpenPending = autoOpenState === 'pending'
    await ensureIdentity($, rt)
    startTimer($, rt)
    if (!rt.enabled) $.ui.status('🎣 off')
    // session.start is awaited before the first prompt: the network goes in a timer, not here.
    $.clock.after(0, () => {
      void runBeat($, rt).then(() => (e.isInteractive ? autoOpenSafely($, rt) : undefined))
    })
    return next(e)
  })

  // SDK sessions (the desktop app, VS Code) start non-interactive and arrive here; a phone is not this machine.
  on('session.attach', async ($, e, next) => {
    if (e.surface === 'desktop' || e.surface === 'vscode') $.clock.after(0, () => void autoOpenSafely($, rt))
    return next(e)
  })

  // Claude is working: main turn start..complete, plus each subagent from its first step to its
  // turn.complete; every model request and tool call (subagents included) is activity.
  on('turn.start', async ($, e, next) => {
    await touchSafely($, rt, { running: true })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await touchSafely($, rt, {}, { model: e.model, effort: e.effort ?? null })
    } else {
      await touchSafely($, rt, rt.turn.agents.includes(e.agentId) ? {} : { agents: [...rt.turn.agents, e.agentId] })
    }
    return yield* next(e)
  })

  // next(e) holds the permission prompt and the tool itself; its end (PostToolUse, or a refusal) is Claude going on.
  on('tool.call', async ($, e, next) => {
    // This plugin's own questions (/fishing link) are neither Claude working nor Claude waiting.
    if (next.origin.plugin === $.plugin.name) return next(e)
    await touchSafely($, rt)
    if (ASKS_USER.has(e.tool)) await setWaitingSafely($, rt, true)
    try {
      return await next(e)
    } finally {
      await touchSafely($, rt)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    await touchSafely($, rt, agentId === undefined ? { running: false } : { agents: rt.turn.agents.filter(id => id !== agentId) })
    return next(e)
  })

  // Claude waits on the person until it goes on (the next step, tool or turn end).
  on('classic.PermissionRequest', async ($, e, next) => {
    await setWaitingSafely($, rt, true)
    const result = await next(e)
    if (result.decision !== undefined) await setWaitingSafely($, rt, false) // a hook beneath answered: no prompt shows
    return result
  })

  on('classic.Elicitation', async ($, e, next) => {
    await setWaitingSafely($, rt, true)
    return next(e)
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    await touchSafely($, rt)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (PROMPT_NOTIFICATION.test(e.notification_type)) await setWaitingSafely($, rt, true)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.to_model !== e.from_model) await switchModelSafely($, rt, e.to_model)
    return next(e)
  })

  on('command.run', { command: 'fishing' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = word.toLowerCase() || 'status'
    if (arg === 'link') return { text: rest.length === 0 ? await createLink($, rt) : await claimLink($, rt, rest.join(' ')) }
    if (arg === 'unlink') return { text: await unlinkMachine($, rt) }
    if (arg === 'on') {
      await turnOn($, rt)
      return { text: `fishing on: ${statusLine(rt) ?? '🎣 connecting'} (${rt.serverUrl})` }
    }
    if (arg === 'off') {
      await $.store.set('enabled', false)
      if (rt.enabled) await turnOff($, rt).catch(() => undefined)
      $.ui.status('🎣 off')
      return { text: 'fishing off: sessions on this machine stop reporting to the game. /fishing on resumes.' }
    }
    if (arg === 'open') {
      // Asking for the game is asking to play: off, it would open locked. The store, as another session may have
      // switched it; the beat lands before the pair. The auto-open never turns fishing on.
      const wasOff = (await $.store.get('enabled')) === false
      if (wasOff) await turnOn($, rt)
      const result = await openGame($, rt, 'manual')
      return { text: wasOff ? `fishing on · ${result.text}` : result.text }
    }
    if (arg !== 'status') return { text: USAGE }
    if (rt.enabled) await runBeat($, rt)
    return { text: await statusReport($, rt) }
  })

  // Awaited; the whole session.end chain shares one ~1.5 s wall-clock bound (next.budget).
  on('session.end', async ($, e, next) => {
    // A /clear (and an in-session /resume) keeps this process going as another conversation: block nothing.
    if (e.reason === 'clear' || e.reason === 'resume') {
      const result = await next(e)
      rt.turn = { running: false, agents: [], waiting: false }
      rt.lastSentWorking = null
      await $.state.set(TURN, rt.turn).catch(() => undefined)
      $.clock.after(0, () => void switchSessionSafely($, rt, e.sessionId))
      return result
    }
    rt.timer?.cancel()
    rt.timer = null
    const timeoutMs = Math.max(100, Math.min(END_TIMEOUT_MS, next.budget.remainingMs - 200))
    await sendEnding($, rt, e.sessionId, timeoutMs).catch(() => undefined)
    $.ui.status(undefined)
    return next(e)
  })
}
