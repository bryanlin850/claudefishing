// Public HTTP contract between the Claude Code mod and the hosted game.
// The game vendors this file from a pinned public commit; it has no game-rule dependencies.
// Additive fields must remain compatible with older deployed servers.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type HeartbeatRequest = {
  /** The Claude Code session id. */
  sessionId: string
  /** false = fishing is off (`fishing` says for the whole machine): drop this session now. */
  enabled: boolean
  /** true on session end: drop this session now. */
  ending?: boolean
  /** Model as the session reports it ("claude-opus-5-5", "opus", ...). */
  model: string | null
  /** Reasoning effort ('low'…'max'), a token budget, or null when unknown. */
  effort: string | number | null
  /** A turn is running right now. */
  working: boolean
  /** ms since the last sign of Claude working (sender's clock), null if never this session. */
  activeAgoMs: number | null
  /** Mod version: a session older than the server's minimum counts for nothing. */
  modVersion?: string
  /**
   * The machine's /fishing on|off as this session read it. The server keeps each machine's newest
   * (highest `rev`): while it is off no session of the machine counts, an older plugin's included,
   * and the flip to off closes the game window the machine opened. Absent from plugins before 0.3.0.
   */
  fishing?: FishingSwitch
  /**
   * What Claude has done in this session, in numbers only, for game mechanics (a server may use it or
   * not). Rides on the beats the session sends anyway. Absent from plugins before 0.4.0.
   */
  work?: WorkReport
}

/** Token counts by kind, as the API counts them. */
export type WorkTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * What Claude has done in a session since `run` began, in numbers only: never a prompt, answer, file,
 * path, command or tool input. The totals only grow while `run` stays the same, so a server takes the
 * change since the last report of that run (a lost beat loses nothing, a repeated one adds nothing);
 * a new `run` starts them over from zero (a /clear or /resume, a reload that lost them).
 */
export type WorkReport = {
  /** A random id for these totals. */
  run: string
  /** Model requests answered, the main loop's and subagents' (turn.step). */
  steps: number
  /** What they used, summed. */
  tokens: WorkTokens
  /** The same by the model that answered ("claude-opus-5-5"), for the first 8 models; requests past those count only above. */
  byModel: Record<string, WorkTokens & { steps: number }>
  /** Main-loop turns ended (turn.complete): of them, how many were interrupted and how many ended on an error or a refusal; their wall-clock ms. */
  turns: { count: number; aborted: number; failed: number; ms: number }
  /** Subagent runs ended (turn.complete with an agent id). */
  agentRuns: number
  /** Tool calls by tool, subagents' included: Claude Code's own by name ("Bash", "Read"), any MCP server's as "mcp", anything else as "other". */
  tools: Record<string, number>
  /** How many different MCP servers those "mcp" calls went to; which ones never leaves the machine. */
  mcpServers: number
  /** The session's latest measure (session.measure); null before the first. */
  measure: WorkMeasure | null
}

/** The session's figures as its status line has them, at the last measure. */
export type WorkMeasure = {
  /** The context window's fill, 0 to 100; null until a response reported one. */
  contextPct: number | null
  /** The context window's size, in tokens. */
  contextWindow: number
  /** The plan's rate-limit windows (`five_hour`, `seven_day`, a gateway's `spend_limit`): percent used, and when each resets (ISO 8601); empty off a subscription. */
  rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[]
  /** What the session has cost so far, in US dollars; null where the host keeps no ledger. */
  costUsd: number | null
}

/**
 * /fishing on|off for a whole machine, shared by every session and every copy of the plugin on it.
 * `rev` counts the flips: of two, the higher is the newer.
 */
export type FishingSwitch = { on: boolean; rev: number }

/**
 * The plugin is older than the latest (`latest`). `required`: older than the server's minimum
 * (`min`), so the game is locked until it is updated with `command`.
 */
export type ModUpdate = { required: boolean; latest: string; min: string | null; command: string }

export type PresenceView = {
  playable: boolean
  sessionCount: number
  /** Display label of the highest model, e.g. "Opus 5.5". */
  model: string | null
  effort: EffortLevel | null
  working: boolean
  buff: BuffView
  /** A live session of the cat runs an older plugin than the latest. Absent from servers before 0.2.0. */
  modUpdate?: ModUpdate | null
}

export type BuffView = {
  active: boolean
  /** Fraction, 0.08 = +8%. 0 while inactive. */
  pct: number
  potentialPct: number
  /** Server-clock ms; null while a turn runs or while inactive. */
  expiresAt: number | null
}

export type HeartbeatResponse = {
  ok: true
  serverTime: number
  /** A game window for this machine's cat is connected right now (opened from any of its machines). */
  clientConnected: boolean
  /** The cat this machine plays; null until it has joined the game once. */
  player: PlayerSummary | null
  /** Machines that play this cat, this one included: more than 1 once devices are linked. */
  machines: number
  /** This machine plays a cat linked from another machine rather than its own. */
  linked: boolean
  /** From the sessions of every machine that plays this cat. */
  presence: PresenceView
  /** This session's plugin is behind (null: up to date). Absent from servers before 0.2.0. */
  modUpdate?: ModUpdate | null
  /**
   * The machine's switch as the server keeps it. Newer than the plugin's (a higher `rev`, or the
   * same flip settled the other way), it is the switch. Absent from servers before 0.3.0.
   */
  fishing?: FishingSwitch
}

/** What a cat has to show for itself, as the mod prints it. */
export type PlayerSummary = { name: string; level: number; rank: string; money: number; totalCaught: number }

export type PairRequest = {
  sessionId: string
  /**
   * 'auto' (session start) is skipped while a window is connected, one was opened moments ago, or
   * fishing is off on the machine; 'manual' always pairs, and turns an off machine on.
   */
  reason: 'auto' | 'manual'
}

export type PairResponse =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; skipped: 'client-connected' | 'recently-opened' | 'fishing-off' }

// A machine plays its own cat (the player whose id is the machine's) until it
// claims a link code made on a machine that plays another one; from then on
// it plays that cat, and `/api/unlink` returns it to its own.

/** A one-time code another machine claims to play this machine's cat, until `expiresAt` (server clock); a newer code replaces it. `no-player`: this machine has no cat yet. */
export type LinkResponse = { ok: true; code: string; expiresAt: number; serverTime: number; player: PlayerSummary } | { ok: false; error: 'no-player' }

export type LinkClaimRequest = {
  code: string
  /** The session asking: it counts for the new cat at once, the machine's other sessions with their next beat. */
  sessionId: string
  /** Switch even though this machine's cat has progress (the person chose to). */
  replace: boolean
}

/** What becomes of the cat a machine stops playing: `unlink` brings it back to this machine, `shared` other machines still play it, `lost` no machine does. */
export type LeftBehind = 'unlink' | 'shared' | 'lost'

/**
 * `has-progress`: this machine's cat has caught or bought something and
 * `replace` was false; nothing changed and the code still works.
 * `invalid-code` comes with HTTP 400, an over-budget claim with 429.
 */
export type LinkClaimResponse =
  | {
      ok: true
      /** This machine already played that cat: nothing changed. */
      already: boolean
      player: PlayerSummary
      /** The cat this machine played before; null if it had none (or `already`). */
      previous: PlayerSummary | null
      /** Machines that play the cat now, this one included. */
      machines: number
      /** This machine's game window was open and reopens as the new cat. */
      windowSwitched: boolean
    }
  | { ok: false; error: 'has-progress'; current: PlayerSummary; target: PlayerSummary; afterwards: LeftBehind }
  | { ok: false; error: 'invalid-code' }

export type UnlinkRequest = {
  sessionId: string
  /** Unlink even though no other machine plays the linked cat (the person chose to). */
  confirm: boolean
}

/** `last-device`: no other machine plays the linked cat, which has progress, and `confirm` was false. */
export type UnlinkResponse =
  | { ok: true; player: PlayerSummary | null; previous: PlayerSummary | null; windowSwitched: boolean }
  | { ok: false; error: 'not-linked' }
  | { ok: false; error: 'last-device'; current: PlayerSummary }
