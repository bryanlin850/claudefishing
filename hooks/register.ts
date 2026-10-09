// claudefishing: connects this machine's Claude Code sessions to the
// claudefishing game. Heartbeats say a session is alive (so the game is
// playable), which model/effort it runs and whether Claude is working (the
// buff); /fishing opens the game, turns reporting on/off, shows status and
// links devices so they play one cat.
//
// On and off are one switch for the whole machine: a file beside the
// identity, which every session and every copy of the plugin reads. Each
// flip is numbered, every heartbeat carries the switch, and the server keeps
// each machine's newest: while it is off, no session of the machine counts,
// not even one running an older plugin that never reads the file.
//
// Only sessions Claude works in count for the buff, so only they keep
// themselves alive: while a turn runs and for the buff window after it. An
// idle session stays quiet unless no session of the machine has beaten for a
// keepalive (another file beside the identity), so a machine with forty
// threads open keeps the game open with one keepalive, not forty. Quiet
// sessions show the last answer any session of the machine got.
//
// Every heartbeat also carries what Claude did in the session, as totals of
// numbers (model requests and their tokens, turns, tool calls, the status
// line's figures), for game mechanics; nothing Claude read or wrote.

import type { EngineInterface, Register, SessionMeasureInput, TurnCompleteInput, TurnStepResult, TurnUsage } from 'claude-code'
import { MOD_VERSION } from '../types/version'

import type { FishingActivity, FishingStep, FishingTurn } from '../types'
import type {
  FishingSwitch,
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
  WorkMeasure,
  WorkReport,
  WorkTokens,
} from '../types/protocol'

const DEFAULT_SERVER_URL = 'https://claudefishing.io' // npm run dev:sync swaps in the dev server in its copy only
// No plugin.json userConfig: Claude Code reports declared options as "not yet set" on install, defaults or
// not. CLAUDEFISHING_AUTO_OPEN=0 (false, no, off), from the shell or the `env` block of settings.json,
// keeps the game from opening by itself. CLAUDEFISHING_SERVER_URL is for development and names a server
// on this machine only: every request carries the machine's secret, and a project's settings can set
// environment variables, so nothing in them may send it anywhere but the game.

/**
 * Every change is sent at once (queueBeat); with none, the server still hears this often from a
 * session Claude worked in within the buff window, and from the machine (any idle session) otherwise.
 */
const KEEPALIVE_MS = 60_000
/** Mirrors the server's presence.sessionTtlMs: no answer on the whole machine for this long, and a quiet session says offline. */
const ANSWER_STALE_MS = 150_000
/** A session taking over the machine's keepalive waits this long after its claim: of claims made together, the last one written beats. */
const CLAIM_SETTLE_MS = 1_000
/** How often the session checks, without the network, whether a keepalive is due or a turn went stale. */
const TICK_MS = 5_000
/** After this session opens the game, every tick beats until the server sees the window join, for at most this long. */
const OPENING_MS = 45_000
const HTTP_TIMEOUT_MS = 4_000
/** /fishing off waits this long for a beat in flight, so its enabled:false lands after it. */
const OFF_INFLIGHT_WAIT_MS = 300
/** The switch before anyone flips it: on, no flips yet. */
const FIRST_SWITCH: FishingSwitch = { on: true, rev: 0 }
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
const USAGE = 'usage: /fishing [status|open [app|browser]|on|off|link [code]|unlink]'
/** Models and tools a work report keeps apart: past these, a request counts in the totals only, a tool as "other". */
const WORK_MODELS = 8
const WORK_TOOLS = 40
/** MCP servers a run tells apart; a new one past these is not counted. */
const WORK_MCP_SERVERS = 64
/**
 * The only tools a work report names: Claude Code's own (this build's, from its tool types, and a
 * few of older builds'). A plugin can register a tool of any name, and an MCP tool names its server,
 * so either could say what someone works with: those count as "other" and "mcp".
 */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Agent', 'AppifactRepl', 'Artifact', 'ArtifactCheck', 'ArtifactComments', 'ArtifactData', 'AskUserQuestion', 'Bash', 'BashOutput',
  'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EndConversation', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode',
  'ExitWorktree', 'FetchInboxMessage', 'GetTask', 'Glob', 'Grep', 'KillShell', 'LS', 'LSP', 'ListAgents', 'ListConnectors',
  'ListMcpResourcesTool', 'ListPlugins', 'ListSkills', 'Monitor', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Poll', 'Projects',
  'ProposeGoal', 'PushNotification', 'Read', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool', 'ReadNotifications', 'RemoteTrigger',
  'ReportFindings', 'ScheduleWakeup', 'SearchMcpRegistry', 'SearchPlugins', 'SearchSkills', 'SendFeedback', 'SendFile', 'SendMessage',
  'SendUserFile', 'SendUserMessage', 'ShareOnboardingGuide', 'ShowOnboardingRolePicker', 'Skill', 'SlashCommand', 'SuggestConnectors',
  'SuggestPluginInstall', 'SuggestSkills', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
])

// Session-scoped values that survive hot reloads (module variables do not).
const ACTIVITY = { plugin: 'claudefishing', key: 'activity' } as const
const TURN = { plugin: 'claudefishing', key: 'turn' } as const
const AUTO_OPEN = { plugin: 'claudefishing', key: 'autoOpen' } as const
const WORK = { plugin: 'claudefishing', key: 'work' } as const
const MCP_SEEN = { plugin: 'claudefishing', key: 'mcpSeen' } as const

/** $.store: how /fishing open opens the game, as the person chose it the first time (or with /fishing open app|browser). */
const OPEN_IN = 'openIn'
/** app: a Chrome app window (on Windows, else an Edge one; else the default browser); browser: the link, to open in any browser. */
type OpenIn = 'app' | 'browser'

type Identity = { secret: string; createdAt: number }

type Link = 'unknown' | 'online' | 'offline'

/** `status` is set when the server answered with an HTTP error, absent when it could not be reached; `code` is the error the answer named. */
type Reply = { ok: true; json: unknown } | { ok: false; error: string; status?: number; code?: string }

type Runtime = {
  /** DEFAULT_SERVER_URL, or a server on this machine from CLAUDEFISHING_SERVER_URL; no trailing slash. */
  serverUrl: string
  /** Open the game once per session (CLAUDEFISHING_AUTO_OPEN turns it off). */
  autoOpen: boolean
  /** This session acts on: reports while on; turned off it went quiet. Follows `fishing.on` within a tick. */
  enabled: boolean
  /** The machine's switch as this session last read it (the file, ~/.claudefishing/fishing.json). */
  fishing: FishingSwitch
  fishingPath: string | null
  /** The flip whose off the server answered (null: none yet): an off it never heard is sent again. */
  offSentRev: number | null
  identityPath: string | null
  identity: Identity | null
  identityError: string | null
  /** The one load (or creation) of the identity, shared by every caller while it runs. */
  identityLoad: Promise<Identity | null> | null
  /** Set when an unreadable identity file was moved aside. */
  identityNote: string | null
  activity: FishingActivity
  turn: FishingTurn
  /** What Claude did in this session, as every beat carries it. */
  work: WorkReport
  /** The MCP servers this run's tool calls went to, by name (`work.mcpServers` counts them): never sent. */
  mcpSeen: string[]
  lastSentWorking: boolean | null
  /** When this session last sent a heartbeat: the next keepalive is due KEEPALIVE_MS after it. */
  lastBeatAt: number | null
  /** ~/.claudefishing/keepalive.json: when any session of the machine last beat. */
  keepalivePath: string | null
  /** ~/.claudefishing/answer.json: the last answer any session of the machine got. */
  answerPath: string | null
  /** When this session last got an answer, or took one from answer.json. */
  answeredAt: number | null
  /** answer.json as this session last wrote or showed it: a quiet session takes it again only once it changed. */
  answerText: string | null
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

/** CLAUDEFISHING_SERVER_URL when it names a server on this machine (development), else DEFAULT_SERVER_URL. */
function serverUrlFrom(value: string | null | undefined): string {
  const fallback = DEFAULT_SERVER_URL.replace(/\/+$/, '')
  if (!value?.trim()) return fallback
  try {
    const url = new URL(value.trim())
    const isThisMachine = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return isThisMachine && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : fallback
  } catch {
    return fallback
  }
}

function autoOpenFrom(value: string | null | undefined): boolean {
  return !/^(0|false|no|off)$/i.test(value?.trim() ?? '')
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

/** ~/.claudefishing, where the identity and the switch live. */
async function homeDir($: EngineInterface): Promise<string> {
  // $.fs does not expand "~" (it resolves against the session cwd): build it from HOME.
  const override = await $.env.get('CLAUDEFISHING_HOME')
  if (override) return override.replace(/\/+$/, '')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return `${home}/.claudefishing`
}

async function identityPath($: EngineInterface): Promise<string> {
  return `${await homeDir($)}/identity.json`
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

// ─── the switch ────────────────────────────────────────────────────────────
// /fishing on|off for the whole machine, in ~/.claudefishing/fishing.json. Plugins
// before 0.3.0 kept it as `enabled` in $.store, which is one file per install (the
// marketplace's, a hand-loaded copy's): each install's store is kept in step with
// the file, so their sessions go on and off with it too. `switchRev` stamps the flip
// a store was last brought to; `enabled` changed under that same stamp is an older
// plugin's /fishing on|off, which counts as one flip more.

function isSwitch(value: unknown): value is FishingSwitch {
  const s = value as Partial<FishingSwitch> | null
  return typeof s === 'object' && s !== null && typeof s.on === 'boolean' && Number.isSafeInteger(s.rev) && (s.rev as number) >= 0
}

function isSameSwitch(a: FishingSwitch, b: FishingSwitch): boolean {
  return a.on === b.on && a.rev === b.rev
}

/** The file; FIRST_SWITCH while there is none, null when it does not read as a switch (being written, or edited by hand). */
async function readSwitchFile($: EngineInterface, rt: Runtime): Promise<FishingSwitch | null> {
  rt.fishingPath ??= `${await homeDir($)}/fishing.json`
  if (!(await $.fs.exists(rt.fishingPath))) return FIRST_SWITCH
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(rt.fishingPath))
    return isSwitch(parsed) ? { on: parsed.on, rev: parsed.rev } : null
  } catch {
    return null
  }
}

// Whole or not at all: other sessions read it every few seconds.
async function writeSwitchFile($: EngineInterface, rt: Runtime, fishing: FishingSwitch): Promise<void> {
  rt.fishingPath ??= `${await homeDir($)}/fishing.json`
  const text = `${JSON.stringify({ on: fishing.on, rev: fishing.rev })}\n`
  const tmp = `${rt.fishingPath}.${hex(crypto.getRandomValues(new Uint8Array(6)))}.tmp`
  await $.fs.write(tmp, text)
  const moved = await $.process.run(['mv', tmp, rt.fishingPath]).catch(() => null)
  if (moved?.exitCode === 0) return
  await $.process.run(['rm', '-f', tmp]).catch(() => undefined)
  await $.fs.write(rt.fishingPath, text) // no mv on this system
}

/** This install's store, as plugins before 0.3.0 read it. `enabled` goes first: a stamp never covers a value it does not stand for. */
async function syncStore($: EngineInterface, fishing: FishingSwitch): Promise<void> {
  await $.store.set('enabled', fishing.on)
  await $.store.set('switchRev', fishing.rev)
}

/** The machine's switch, with what an older plugin in this install did to it since; this install's store follows it. */
async function loadSwitch($: EngineInterface, rt: Runtime): Promise<FishingSwitch> {
  const file = await readSwitchFile($, rt)
  if (file === null) return rt.fishing
  const enabled = await $.store.get('enabled')
  const stamp = await $.store.get('switchRev')
  const stored = typeof enabled === 'boolean' ? enabled : null
  let fishing = file
  if (Number.isSafeInteger(stamp)) {
    const rev = stamp as number
    // An older plugin flipped `enabled` under the stamp: one flip more. A stamp ahead of the file: the file was lost.
    if (rev === file.rev && stored !== null && stored !== file.on) fishing = { on: stored, rev: file.rev + 1 }
    else if (rev > file.rev) fishing = { on: stored !== false, rev }
  } else if (stored === false && isSameSwitch(file, FIRST_SWITCH)) {
    fishing = { on: false, rev: 1 } // turned off before 0.3.0: the first flip
  }
  if (!isSameSwitch(fishing, file)) await writeSwitchFile($, rt, fishing)
  if (stored !== fishing.on || stamp !== fishing.rev) await syncStore($, fishing)
  rt.fishing = fishing
  return fishing
}

/** /fishing on|off: one flip more, for every session of the machine (and, with the next beat, the server). */
async function flip($: EngineInterface, rt: Runtime, on: boolean): Promise<FishingSwitch> {
  const before = await loadSwitch($, rt)
  const fishing = { on, rev: before.rev + 1 }
  await writeSwitchFile($, rt, fishing)
  await syncStore($, fishing)
  rt.fishing = fishing
  return fishing
}

/** The server's switch, when newer than this session's: a lost file, or the same flip settled the other way. True when taken. */
async function adoptServerSwitch($: EngineInterface, rt: Runtime, theirs: unknown): Promise<boolean> {
  if (!isSwitch(theirs)) return false
  const ours = rt.fishing
  if (theirs.rev < ours.rev || (theirs.rev === ours.rev && theirs.on === ours.on)) return false
  const fishing = { on: theirs.on, rev: theirs.rev }
  await writeSwitchFile($, rt, fishing)
  await syncStore($, fishing)
  rt.fishing = fishing
  return true
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
    fishing: { on: rt.fishing.on, rev: rt.fishing.rev },
    work: rt.work,
  }
}

function applyReply(rt: Runtime, reply: Reply): HeartbeatResponse | null {
  const res = reply.ok ? asHeartbeatResponse(reply.json) : null
  rt.link = res !== null ? 'online' : 'offline'
  rt.linkError = res !== null ? null : reply.ok ? 'unexpected answer' : reply.error
  rt.last = res ?? rt.last
  if (res?.clientConnected === true) rt.openingUntil = null // the awaited window joined
  return res
}

/** This session is quiet from now on (the server knows: `offSentRev` is the off it heard). */
function stopReporting(rt: Runtime, offSentRev: number | null): void {
  rt.enabled = false
  rt.lastSentWorking = null
  rt.openingUntil = null
  rt.offSentRev = offSentRev
  rt.link = 'unknown'
  rt.last = null
}

async function beat($: EngineInterface, rt: Runtime): Promise<void> {
  // /fishing on|off may have run in another session, or another copy of the plugin, on this machine.
  const fishing = await loadSwitch($, rt).catch(() => rt.fishing)
  if (!fishing.on) {
    // The server hears of an off once from each session (and again, while it never answers).
    if (rt.enabled || rt.offSentRev !== fishing.rev) await turnOff($, rt)
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
  // Before it goes, so idle sessions ticking meanwhile leave the machine's keepalive to this beat.
  await stampKeepalive($, rt, sessionId, now).catch(() => undefined)
  const seq = ++rt.sentSeq
  const request = postJson($, rt, '/api/heartbeat', identity.secret, body, HTTP_TIMEOUT_MS)
  rt.inFlight = request
  const reply = await request
  if (rt.inFlight === request) rt.inFlight = null
  if (seq < rt.appliedSeq || !rt.enabled) return
  rt.appliedSeq = seq
  const res = applyReply(rt, reply)
  if (res !== null) {
    rt.answeredAt = now
    await shareAnswer($, rt, now, res).catch(() => undefined)
  }
  // The server has a newer switch: off, this session goes quiet at once (the server already said so).
  if (res !== null && (await adoptServerSwitch($, rt, res.fishing).catch(() => false)) && !rt.fishing.on) {
    stopReporting(rt, rt.fishing.rev)
    $.ui.status('🎣 off')
    return
  }
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

// ─── one keepalive per machine ─────────────────────────────────────────────
// The game needs two things of a machine: that Claude Code is open on it, and which sessions
// Claude worked in within the buff window. Every beat is stamped in keepalive.json before it goes,
// and an idle session keeps the machine alive only when that stamp is a keepalive old: the session
// that kept it alive last goes on, any other claims it first (sessions finding it due together
// would all beat otherwise). Every answer lands in answer.json unless a newer one is there, and the
// quiet sessions' status lines follow it. Both are written in place: a torn read costs one extra
// beat, or one tick of an older status line.

/** `claim`: a session taking the keepalive over wrote it, and beats if it is still its claim CLAIM_SETTLE_MS later. */
type KeepaliveStamp = { at: number; sessionId: string; claim?: string }

type SharedAnswer = { at: number; modVersion: string; answer: HeartbeatResponse }

/** Claude works in this session, or did within the buff window: the server counts it for the buff, so it keeps itself alive. */
function isReporting(rt: Runtime, now: number): boolean {
  const last = rt.activity.lastActiveAt
  return isWorking(rt, now) || (last !== null && now - last < INACTIVE_MS)
}

/** When a session of the machine last beat (or claimed the keepalive), and which; null with no stamp, or one that does not read. */
async function readKeepalive($: EngineInterface, rt: Runtime): Promise<KeepaliveStamp | null> {
  rt.keepalivePath ??= `${await homeDir($)}/keepalive.json`
  try {
    if (!(await $.fs.exists(rt.keepalivePath))) return null
    const { at, sessionId, claim } = JSON.parse(await $.fs.read(rt.keepalivePath)) as Partial<Record<keyof KeepaliveStamp, unknown>>
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof sessionId !== 'string') return null
    return { at, sessionId, ...(typeof claim === 'string' ? { claim } : {}) }
  } catch {
    return null
  }
}

async function stampKeepalive($: EngineInterface, rt: Runtime, sessionId: string, now: number, claim?: string): Promise<void> {
  rt.keepalivePath ??= `${await homeDir($)}/keepalive.json`
  const stamp: KeepaliveStamp = { at: now, sessionId, ...(claim !== undefined ? { claim } : {}) }
  await $.fs.write(rt.keepalivePath, `${JSON.stringify(stamp)}\n`)
}

/** Claims the machine's keepalive: true when no claim written meanwhile (or beat sent) replaced this one. */
async function claimKeepalive($: EngineInterface, rt: Runtime, sessionId: string, now: number): Promise<boolean> {
  const claim = hex(crypto.getRandomValues(new Uint8Array(6)))
  await stampKeepalive($, rt, sessionId, now, claim)
  await $.clock.sleep(CLAIM_SETTLE_MS)
  return (await readKeepalive($, rt))?.claim === claim
}

/** The last answer any session of the machine got, and the file's text; null with none, or one that does not read. */
async function readAnswer($: EngineInterface, rt: Runtime): Promise<(SharedAnswer & { text: string }) | null> {
  rt.answerPath ??= `${await homeDir($)}/answer.json`
  try {
    if (!(await $.fs.exists(rt.answerPath))) return null
    const text = await $.fs.read(rt.answerPath)
    const shared = JSON.parse(text) as Partial<SharedAnswer> | null
    const answer = asHeartbeatResponse(shared?.answer)
    if (answer === null || typeof answer.serverTime !== 'number' || typeof shared?.at !== 'number' || typeof shared.modVersion !== 'string') return null
    return { at: shared.at, modVersion: shared.modVersion, answer, text }
  } catch {
    return null
  }
}

/** Unless a newer answer is there already: two sessions' answers can land in either order (of two as old, the later one written stays). */
async function shareAnswer($: EngineInterface, rt: Runtime, now: number, answer: HeartbeatResponse): Promise<void> {
  const current = await readAnswer($, rt)
  if (current !== null && current.answer.serverTime > answer.serverTime) return
  rt.answerPath ??= `${await homeDir($)}/answer.json`
  const text = `${JSON.stringify({ at: now, modVersion: MOD_VERSION, answer } satisfies SharedAnswer)}\n`
  await $.fs.write(rt.answerPath, text)
  rt.answerText = text
}

/** Its own keepalive while the server counts it for the buff; past that, the machine's, once no session has beaten for one. */
async function isKeepaliveDue($: EngineInterface, rt: Runtime, now: number): Promise<boolean> {
  if (rt.lastBeatAt !== null && now - rt.lastBeatAt < KEEPALIVE_MS) return false
  if (isReporting(rt, now)) return true
  const stamp = await readKeepalive($, rt)
  if (stamp !== null && now - stamp.at < KEEPALIVE_MS) return false
  const sessionId = await $.session.id()
  return stamp?.sessionId === sessionId || claimKeepalive($, rt, sessionId, now)
}

// A quiet session shows the newest answer of the machine: one it has not shown yet, no older than its
// own. With none for a session's lifetime on the server, no session of the machine reaches the game:
// offline, as the one trying to will be.
async function followAnswer($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const shared = await readAnswer($, rt)
  if (shared !== null && shared.text !== rt.answerText && shared.answer.serverTime >= (rt.last?.serverTime ?? -Infinity)) {
    rt.answerText = shared.text
    // An answer to another version of the plugin says nothing about this one's updates.
    const modUpdate = shared.modVersion === MOD_VERSION ? (shared.answer.modUpdate ?? null) : (rt.last?.modUpdate ?? null)
    rt.last = { ...shared.answer, modUpdate }
    rt.link = 'online'
    rt.linkError = null
    rt.answeredAt = shared.at
    if (rt.last.clientConnected) rt.openingUntil = null
    $.ui.status(statusLine(rt))
    toastUpdate($, rt)
    if (rt.isAutoOpenPending) void autoOpenSafely($, rt)
    return
  }
  const answeredAt = Math.max(rt.answeredAt ?? -Infinity, shared?.at ?? -Infinity)
  if (rt.link === 'online' && now - answeredAt > ANSWER_STALE_MS) {
    rt.link = 'offline'
    rt.linkError = 'no session on this machine got an answer lately'
    $.ui.status(statusLine(rt))
  }
}

// A keepalive once one is due (isKeepaliveDue), a beat as soon as a turn goes stale (STALE_TURN_MS)
// and stops counting as work, and one every tick while a window this session opened has not joined
// (the server only says so in a beat's answer); otherwise the status line follows the machine's
// answers. The switch is read every tick (no network): a flip anywhere on the machine reaches this
// session within one.
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  if (rt.openingUntil !== null && now >= rt.openingUntil) {
    rt.openingUntil = null // it never joined: "game closed" again, and keepalives only
    $.ui.status(statusLine(rt))
  }
  const fishing = await loadSwitch($, rt).catch(() => rt.fishing)
  if (fishing.on !== rt.enabled) return runBeat($, rt)
  if (!fishing.on) {
    // An off the server never answered goes again, a keepalive after the last try.
    if (rt.offSentRev !== fishing.rev && (rt.lastBeatAt === null || now - rt.lastBeatAt >= KEEPALIVE_MS)) await runBeat($, rt)
    return
  }
  const isStale = rt.lastSentWorking === true && !isWorking(rt, now)
  if (rt.openingUntil === null && !isStale && !(await isKeepaliveDue($, rt, now))) return followAnswer($, rt, now).catch(() => undefined)
  // Counted as a beat even if it cannot be sent (offline): the next try is a keepalive later.
  rt.lastBeatAt = now
  await runBeat($, rt)
}

function startTimer($: EngineInterface, rt: Runtime): void {
  rt.timer?.cancel()
  // Keeps ticking while off too (no network then) so a /fishing on from another session resumes this one.
  rt.timer = $.clock.every(TICK_MS, () => void tick($, rt))
}

// /fishing on, and /fishing open when off: a flip on, which every session of the machine follows.
async function turnOn($: EngineInterface, rt: Runtime): Promise<void> {
  await flip($, rt, true)
  rt.enabled = true
  startTimer($, rt)
  await runBeat($, rt)
}

// The server drops this session now rather than after its TTL. An off it has not heard of yet (a
// newer flip) drops every session of the machine and closes the game window the machine opened.
async function turnOff($: EngineInterface, rt: Runtime): Promise<void> {
  const fishing = rt.fishing
  stopReporting(rt, rt.offSentRev)
  if (rt.inFlight !== null) await Promise.race([rt.inFlight, $.clock.sleep(OFF_INFLIGHT_WAIT_MS)]) // land it first
  const identity = rt.identity
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  rt.lastBeatAt = now // a try that gets no answer goes again a keepalive later
  if (identity === null || isRecentlyEnded(rt, sessionId, now)) return
  const body = await heartbeatBody($, rt, sessionId, now)
  const reply = await postJson($, rt, '/api/heartbeat', identity.secret, { ...body, enabled: false }, HTTP_TIMEOUT_MS)
  if (!reply.ok) return
  // Heard (a server from before the switch hears it too): sent. A newer switch there wins; on, the next tick resumes.
  rt.offSentRev = fishing.rev
  await adoptServerSwitch($, rt, asHeartbeatResponse(reply.json)?.fishing).catch(() => false)
}

/** `work`: the ended conversation's totals (after a /clear, this process already counts the next one's). */
async function sendEnding($: EngineInterface, rt: Runtime, sessionId: string, timeoutMs: number, work: WorkReport = rt.work): Promise<void> {
  const now = await $.clock.now()
  markEnded(rt, sessionId, now)
  const identity = rt.identity
  if (!rt.enabled || identity === null) return
  const body = await heartbeatBody($, rt, sessionId, now)
  await postJson($, rt, '/api/heartbeat', identity.secret, { ...body, work, working: false, ending: true }, timeoutMs)
}

/** A conversation's run as it ended: its totals, and the MCP servers they count. */
type EndedRun = { work: WorkReport; mcpSeen: string[] }

// After a /clear or an in-session /resume the process goes on as another conversation: beat as it
// first, then end the old id (with its totals), so the server never sees this machine without a session.
async function switchSession($: EngineInterface, rt: Runtime, endedId: string, ended: EndedRun): Promise<void> {
  let sessionId = await $.session.id()
  for (let i = 0; sessionId === endedId && i < SWITCH_POLLS; i++) {
    await $.clock.sleep(SWITCH_POLL_MS)
    sessionId = await $.session.id()
  }
  if (sessionId === endedId) {
    // Still the same conversation: nothing to end, and its run goes on.
    rt.work = ended.work
    rt.mcpSeen = ended.mcpSeen
    await $.state.set(WORK, rt.work).catch(() => undefined)
    await $.state.set(MCP_SEEN, rt.mcpSeen).catch(() => undefined)
    return runBeat($, rt)
  }
  const endedAt = rt.endedAt.get(sessionId)
  if (endedAt !== undefined) {
    // Back to a conversation ended moments ago: the server ignores its beats until its tombstone passes.
    const wait = endedAt + SERVER_TOMBSTONE_MS + 500 - (await $.clock.now())
    if (wait > 0) await $.clock.sleep(wait)
    rt.endedAt.delete(sessionId)
  }
  await runBeat($, rt)
  await sendEnding($, rt, endedId, HTTP_TIMEOUT_MS, ended.work)
}

async function switchSessionSafely($: EngineInterface, rt: Runtime, endedId: string, ended: EndedRun): Promise<void> {
  try {
    await switchSession($, rt, endedId, ended)
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

// ─── what Claude did ───────────────────────────────────────────────────────
// Totals for game mechanics, on the beats the session sends anyway (the server may use them or not):
// numbers only, never what Claude read or wrote. Kept in $.state, so a hot reload goes on counting
// the same run; a /clear or /resume starts a new one.

function noTokens(): WorkTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function newWork(): WorkReport {
  return {
    run: hex(crypto.getRandomValues(new Uint8Array(6))),
    steps: 0,
    tokens: noTokens(),
    byModel: {},
    turns: { count: 0, aborted: 0, failed: 0, ms: 0 },
    agentRuns: 0,
    tools: {},
    mcpServers: 0,
    measure: null,
  }
}

/** The totals a previous load of the module kept, with any field it did not have yet at zero. */
function restoreWork(kept: Partial<WorkReport> | undefined): WorkReport {
  if (typeof kept?.run !== 'string') return newWork()
  const fresh = newWork()
  return {
    ...fresh,
    ...kept,
    run: kept.run,
    tokens: { ...fresh.tokens, ...kept.tokens },
    byModel: { ...kept.byModel },
    turns: { ...fresh.turns, ...kept.turns },
    tools: { ...kept.tools },
  }
}

/** A count from the engine; anything not a finite, non-negative number counts as none. */
function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function addTokens(to: WorkTokens, usage: TurnUsage): void {
  to.input += amount(usage.input_tokens)
  to.output += amount(usage.output_tokens)
  to.cacheRead += amount(usage.cache_read_input_tokens)
  to.cacheWrite += amount(usage.cache_creation_input_tokens)
}

/** A tool as the game hears of it: Claude Code's own by name, never which MCP server or plugin. */
function toolKind(tool: string): string {
  if (tool.startsWith('mcp__')) return 'mcp'
  return BUILTIN_TOOLS.has(tool) ? tool : 'other'
}

/** A response's model and tokens; a request no response answered counts for nothing. */
function countStep(work: WorkReport, result: TurnStepResult): void {
  if (result.stopReason === null && result.usage === null) return
  work.steps += 1
  const usage = result.usage
  if (usage === null) return
  addTokens(work.tokens, usage)
  const model = typeof usage.model === 'string' && /^[a-z0-9][a-z0-9.:@-]{0,99}$/i.test(usage.model) ? usage.model : 'other'
  const byModel = work.byModel[model] ?? (Object.keys(work.byModel).length < WORK_MODELS ? (work.byModel[model] = { steps: 0, ...noTokens() }) : null)
  if (byModel === null) return
  byModel.steps += 1
  addTokens(byModel, usage)
}

/** True when the call went to an MCP server the run had not seen: `seen` holds the names, the report only how many. */
function countTool(work: WorkReport, seen: string[], tool: string): boolean {
  const kind = toolKind(tool)
  const key = work.tools[kind] !== undefined || Object.keys(work.tools).length < WORK_TOOLS ? kind : 'other'
  work.tools[key] = (work.tools[key] ?? 0) + 1
  const server = kind === 'mcp' ? tool.split('__')[1] : undefined
  if (!server || seen.includes(server) || seen.length >= WORK_MCP_SERVERS) return false
  seen.push(server)
  work.mcpServers += 1
  return true
}

function countTurn(work: WorkReport, e: TurnCompleteInput): void {
  if (e.agentId !== undefined) {
    work.agentRuns += 1
    return
  }
  work.turns.count += 1
  if (e.isAborted) work.turns.aborted += 1
  if (e.reason === 'error' || e.reason === 'refusal') work.turns.failed += 1
  work.turns.ms += amount(e.durationMs)
}

function measureOf(e: SessionMeasureInput): WorkMeasure {
  return {
    contextPct: typeof e.context?.percent === 'number' && Number.isFinite(e.context.percent) ? e.context.percent : null,
    contextWindow: amount(e.context?.window),
    rateLimits: (e.rateLimits ?? []).slice(0, 4).map(limit => ({
      kind: String(limit.kind).slice(0, 32),
      percentUsed: amount(limit.percentUsed),
      resetsAt: typeof limit.resetsAt === 'string' ? limit.resetsAt.slice(0, 40) : null,
    })),
    costUsd: typeof e.cost?.usd === 'number' && Number.isFinite(e.cost.usd) ? e.cost.usd : null,
  }
}

// Counting never holds up Claude: a failure loses one count, kept in memory for the next beat.
async function countSafely($: EngineInterface, rt: Runtime, change: (work: WorkReport) => void): Promise<void> {
  try {
    change(rt.work)
    await $.state.set(WORK, rt.work)
  } catch {
    // the next count saves it
  }
}

async function countToolSafely($: EngineInterface, rt: Runtime, tool: string): Promise<void> {
  try {
    const isNewServer = countTool(rt.work, rt.mcpSeen, tool)
    await $.state.set(WORK, rt.work)
    if (isNewServer) await $.state.set(MCP_SEEN, rt.mcpSeen)
  } catch {
    // the next count saves it
  }
}

/** The kept server names, from a previous load of the module; anything else is none. */
function restoreSeen(kept: unknown): string[] {
  return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === 'string').slice(0, WORK_MCP_SERVERS) : []
}

// ─── opening the game ──────────────────────────────────────────────────────

/** Windows: PowerShell's Start-Process finds `browser` as Run would (its App Paths entry), returns once it starts, and fails with no dialog when it is not there. */
function windowsAppWindow(browser: 'chrome' | 'msedge', url: string): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process ${browser} '--app=${url.replaceAll("'", "''")}'`]
}

async function openUrl($: EngineInterface, url: string): Promise<string | null> {
  const tries: [argv: string[], how: string][] =
    (await $.env.get('OS')) === 'Windows_NT'
      ? // Windows: a Chrome app window, else an Edge one (Edge comes with Windows), else the default browser.
        [
          [windowsAppWindow('chrome', url), 'a Chrome app window'],
          [windowsAppWindow('msedge', url), 'an Edge app window'],
          [['rundll32.exe', 'url.dll,FileProtocolHandler', url], 'the default browser'],
        ]
      : // macOS: -n so --args reach a Chrome that is already running; then the default browser.
        [
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

/** How the game opens as the person chose it; null until they did (or when the store cannot be read). */
async function loadOpenIn($: EngineInterface): Promise<OpenIn | null> {
  const value = await $.store.get(OPEN_IN).catch(() => undefined)
  return value === 'app' || value === 'browser' ? value : null
}

const OPEN_OPTIONS = ['App window', 'Browser link'] as const

/** The first /fishing open asks; null when the question was dismissed or nobody could be asked (`claude -p`). */
async function askOpenIn($: EngineInterface): Promise<OpenIn | null> {
  const question = 'Open claudefishing in an app window, or get a link to open in your own browser?'
  const answer = await $.ui.ask(question, { header: 'Open game', options: OPEN_OPTIONS }).catch(() => null)
  if (answer === null) return null
  // Typed under "Other" too: "app", "browser", "a link", "tab".
  if (answer === OPEN_OPTIONS[0] || /^\s*app\b/i.test(answer)) return 'app'
  if (answer === OPEN_OPTIONS[1] || /\b(browser|link|tab)\b/i.test(answer)) return 'browser'
  return null
}

/** unreachable: the pair request got no answer at all (worth trying again); failed: anything else that went wrong. */
type OpenResult = { kind: 'opened' | 'skipped' | 'failed' | 'unreachable'; text: string }

async function openGame($: EngineInterface, rt: Runtime, reason: PairRequest['reason'], openIn: OpenIn): Promise<OpenResult> {
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
    const why = { 'client-connected': 'the game is already open', 'recently-opened': 'the game was opened moments ago', 'fishing-off': 'fishing is off on this machine' }
    return { kind: 'skipped', text: why[pair.skipped] ?? why['recently-opened'] }
  }
  if (typeof pair.code !== 'string') return { kind: 'failed', text: 'unexpected answer from the server' }
  const url = `${rt.serverUrl}/#pair=${encodeURIComponent(pair.code)}`
  let text: string
  if (openIn === 'browser') {
    const copied = (await $.ui.copy({ text: url }).catch(() => null))?.isCopied === true
    text = `open this link in your browser${copied ? ' (copied)' : ''}; it works once, for 2 minutes:\n${url}`
  } else {
    const how = await openUrl($, url)
    if (how === null) return { kind: 'failed', text: `could not start a browser; open ${url} yourself (the link works once, for 2 minutes)` }
    text = `opened in ${how}`
  }
  // The window takes a few seconds to load and join: until a beat's answer says it did, the line says so.
  rt.openingUntil = (await $.clock.now()) + OPENING_MS
  $.ui.status(statusLine(rt))
  return { kind: 'opened', text }
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
    // With the browser chosen there is no window to open, and a link nobody asked for would only expire.
    const result: OpenResult =
      (await loadOpenIn($)) === 'browser' ? { kind: 'skipped', text: 'the game opens with /fishing open' } : await openGame($, rt, 'auto', 'app')
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
    lines.push(`sessions: ${res.presence.sessionCount} reporting ${where} (idle ones stay quiet) · shown as ${res.presence.model ?? 'unknown'}${res.presence.effort ? ` · ${res.presence.effort}` : ''}`)
    lines.push(`buff: ${buffText(res)}`)
  }
  const doing = body.working ? ' · working' : rt.turn.waiting ? ' · waiting on you' : isReporting(rt, now) ? '' : ' · idle'
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

export const register: Register = on => {
  const rt: Runtime = {
    serverUrl: DEFAULT_SERVER_URL, // session.start reads the environment
    autoOpen: true,
    enabled: true,
    fishing: FIRST_SWITCH,
    fishingPath: null,
    offSentRev: null,
    identityPath: null,
    identity: null,
    identityError: null,
    identityLoad: null,
    identityNote: null,
    activity: { lastActiveAt: null, step: null },
    turn: { running: false, agents: [], waiting: false },
    work: newWork(),
    mcpSeen: [],
    lastSentWorking: null,
    lastBeatAt: null,
    keepalivePath: null,
    answerPath: null,
    answeredAt: null,
    answerText: null,
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
      description: 'claudefishing: status | open [app|browser] | on | off | link | unlink',
      argumentHint: '[status|open [app|browser]|on|off|link [code]|unlink]',
    })
    rt.serverUrl = serverUrlFrom(await $.env.get('CLAUDEFISHING_SERVER_URL'))
    rt.autoOpen = autoOpenFrom(await $.env.get('CLAUDEFISHING_AUTO_OPEN'))
    const { value: activity } = await $.state.get(ACTIVITY)
    if (activity !== undefined) rt.activity = activity
    // A reload mid-turn keeps the turn, its subagents and a prompt waiting on the person.
    const { value: turn } = await $.state.get(TURN)
    if (turn !== undefined) rt.turn = turn
    // And goes on counting the same run.
    const { value: work } = await $.state.get(WORK)
    rt.work = restoreWork(work)
    const { value: mcpSeen } = await $.state.get(MCP_SEEN)
    rt.mcpSeen = restoreSeen(mcpSeen)
    const { value: autoOpenState } = await $.state.get(AUTO_OPEN)
    rt.isAutoOpenPending = autoOpenState === 'pending'
    await ensureIdentity($, rt) // first: it makes ~/.claudefishing owner-only
    rt.enabled = (await loadSwitch($, rt).catch(() => rt.fishing)).on
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
    const result = yield* next(e)
    await countSafely($, rt, work => countStep(work, result))
    return result
  })

  // next(e) holds the permission prompt and the tool itself; its end (PostToolUse, or a refusal) is Claude going on.
  on('tool.call', async ($, e, next) => {
    // This plugin's own questions (/fishing link) are neither Claude working nor Claude waiting.
    if (next.origin.plugin === $.plugin.name) return next(e)
    await countToolSafely($, rt, e.tool)
    await touchSafely($, rt)
    if (ASKS_USER.has(e.tool)) await setWaitingSafely($, rt, true)
    try {
      return await next(e)
    } finally {
      await touchSafely($, rt)
    }
  })

  // Counted first: the beat the turn's end sends carries it.
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    await countSafely($, rt, work => countTurn(work, e))
    await touchSafely($, rt, agentId === undefined ? { running: false } : { agents: rt.turn.agents.filter(id => id !== agentId) })
    return next(e)
  })

  // The status line's figures (context, plan limits, cost) as of the latest measure: not Claude doing anything.
  on('session.measure', async ($, e, next) => {
    await countSafely($, rt, work => {
      work.measure = measureOf(e)
    })
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
      const failed = await turnOn($, rt).then(() => null, errorText)
      if (failed !== null) return { text: `fishing stays as it was: the switch could not be saved (${failed})` }
      return { text: `fishing on: ${statusLine(rt) ?? '🎣 connecting'} (${rt.serverUrl})` }
    }
    if (arg === 'off') {
      // Always one flip more, even when off already: the server closes any window this machine opened since.
      const failed = await flip($, rt, false).then(() => null, errorText)
      if (failed !== null) return { text: `fishing stays as it was: the switch could not be saved (${failed})` }
      await turnOff($, rt).catch(() => undefined)
      $.ui.status('🎣 off')
      return { text: 'fishing off: no session on this machine reports to the game, and its game window closes. /fishing on resumes.' }
    }
    if (arg === 'open') {
      const named = rest[0]?.toLowerCase()
      if (named !== undefined && named !== 'app' && named !== 'browser') return { text: USAGE }
      // How to open it: as named (and kept), else as chosen before, else asked (and kept). Unanswered: the app window.
      let openIn: OpenIn | null = named ?? (await loadOpenIn($))
      let note: string | null = null
      if (named !== undefined || openIn === null) {
        openIn = named ?? (await askOpenIn($))
        if (openIn !== null && (await $.store.set(OPEN_IN, openIn).then(() => true, () => false))) {
          const way = openIn === 'app' ? 'an app window' : 'a link for your browser'
          note = `/fishing open gives you ${way} from now on; /fishing open app or /fishing open browser changes it.`
        }
      }
      // Asking for the game is asking to play: off, it would open locked. The switch, as another session may have
      // flipped it; the beat lands before the pair. The auto-open never turns fishing on.
      const wasOff = !(await loadSwitch($, rt).catch(() => rt.fishing)).on
      if (wasOff) {
        const failed = await turnOn($, rt).then(() => null, errorText)
        if (failed !== null) return { text: `fishing stays off: the switch could not be saved (${failed})` }
      }
      const result = await openGame($, rt, 'manual', openIn ?? 'app')
      return { text: [wasOff ? `fishing on · ${result.text}` : result.text, ...(note === null ? [] : [note])].join('\n') }
    }
    if (arg !== 'status') return { text: USAGE }
    await runBeat($, rt) // on: fresh numbers; off: a flip elsewhere shows
    return { text: await statusReport($, rt) }
  })

  // Awaited; the whole session.end chain shares one ~1.5 s wall-clock bound (next.budget).
  on('session.end', async ($, e, next) => {
    // A /clear (and an in-session /resume) keeps this process going as another conversation: block nothing.
    if (e.reason === 'clear' || e.reason === 'resume') {
      const result = await next(e)
      const ended: EndedRun = { work: rt.work, mcpSeen: rt.mcpSeen }
      rt.turn = { running: false, agents: [], waiting: false }
      rt.work = newWork()
      rt.mcpSeen = []
      rt.lastSentWorking = null
      await $.state.set(TURN, rt.turn).catch(() => undefined)
      await $.state.set(WORK, rt.work).catch(() => undefined)
      await $.state.set(MCP_SEEN, rt.mcpSeen).catch(() => undefined)
      $.clock.after(0, () => void switchSessionSafely($, rt, e.sessionId, ended))
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
