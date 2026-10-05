// Public HTTP contract between the Claude Code mod and the hosted game.
// The game vendors this file from a pinned public commit; it has no game-rule dependencies.
// Additive fields must remain compatible with older deployed servers.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type HeartbeatRequest = {
  /** The Claude Code session id. */
  sessionId: string
  /** false = the person turned fishing off in this session: drop it now. */
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
}

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
}

/** What a cat has to show for itself, as the mod prints it. */
export type PlayerSummary = { name: string; level: number; rank: string; money: number; totalCaught: number }

export type PairRequest = {
  sessionId: string
  /** 'auto' (session start) is skipped while a window is connected or one was opened moments ago; 'manual' always pairs. */
  reason: 'auto' | 'manual'
}

export type PairResponse =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; skipped: 'client-connected' | 'recently-opened' }

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
