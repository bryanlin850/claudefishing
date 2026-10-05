/** Claude's activity in this session, as the mod saw it (kept in $.state so a hot reload keeps it). */
export type FishingActivity = {
  /** Clock ms of the last turn start, model request, tool call or return, or turn end; null before any. */
  lastActiveAt: number | null
  /** Model and effort of the last main-loop model request (or the model a /model switched to); null before the first. */
  step: FishingStep | null
}

export type FishingStep = {
  model: string
  /** Absent on models without effort, and unknown after a /model until the next step: null. */
  effort: string | number | null
}

/** Whether Claude is mid-turn (kept in $.state so a hot reload mid-turn keeps it). */
export type FishingTurn = {
  /** A main-loop turn is running (turn.start until its turn.complete). */
  running: boolean
  /** Subagents seen stepping whose turn.complete has not come yet. */
  agents: string[]
  /** Claude waits on the person: a permission prompt, a question, plan approval or an MCP form. */
  waiting: boolean
}

/** pending: the auto-open could not reach the server and is tried again; done: the server answered it. */
export type AutoOpenState = 'pending' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'claudefishing': {
      activity: FishingActivity
      turn: FishingTurn
      autoOpen: AutoOpenState
    }
  }
}
