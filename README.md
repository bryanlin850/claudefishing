# claudefishing

The Claude Code plugin for **claudefishing**, a small multiplayer fishing game
you play while a Claude Code session is open. The plugin connects your
sessions to the game:

* the game is playable while at least one Claude Code session on your machine
  runs this plugin with fishing on;
* while Claude is working (a turn is running, or it did something in the last
  5 minutes, subagents included) your cat gets a slight buff, scaled by the
  session's model and effort, which also show on your nametag. Time Claude
  spends waiting on you (a permission prompt, a question, plan approval, an
  MCP form) does not count as working;
* `/fishing open` opens the game. The first time, it asks whether you want an
  app window (a chromeless Chrome window) or a link to open in your own
  browser, and remembers the answer (`/fishing open app` or `/fishing open
  browser` changes it). With the app window, the game also opens on its own
  once per session when one starts (unless `CLAUDEFISHING_AUTO_OPEN=0`).

This is a Claude Code mod: `hooks/register.ts` runs inside Claude Code.
The game and server are hosted separately; installing the mod requires no game
source or build step. Requires Claude Code 2.1.287 or later; development checks
use 2.1.289. The mod adds no skills, MCP server, or model calls.

## Install

Pick one, then type **`/reload-plugins`** in any Claude Code session that is
already open (a new session loads the plugin by itself).

**Terminal** (recommended):

```sh
claude plugin marketplace add bryanlin850/claudefishing
claude plugin install claudefishing@claudefishing
```

or, inside a terminal session of Claude Code, `/plugin marketplace add
bryanlin850/claudefishing`, then `/plugin install claudefishing@claudefishing`.

**Claude desktop app**: typing `/plugin marketplace add …` in the Code tab
drops its arguments, so either

1. send Claude this message; it runs the two commands above with the app's own
   copy of `claude`, which is often not on your `PATH`:

   ```
   Install the claudefishing plugin for me by running this in the shell:
   c="${CLAUDE_CODE_EXECPATH:-claude}"; "$c" plugin marketplace add bryanlin850/claudefishing && "$c" plugin install claudefishing@claudefishing
   When it finishes, tell me to type /reload-plugins.
   ```

2. or open **Settings**, scroll to **Plugins**, click **Add**, choose **Add
   from a repository** and paste `https://github.com/bryanlin850/claudefishing`.
   That adds the marketplace only: find **claudefishing** in the list and
   click **Install**.

Then type **`/reload-plugins`** in the Code tab.

**One session, from a checkout**

```sh
claude --plugin-dir /path/to/claudefishing
```

**Every session from a checkout, including the desktop app**: name the folder
in `CLAUDE_CODE_PLUGIN_DIRS`, in your shell or in the `env` block of
`~/.claude/settings.json` (the desktop app reads the latter):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claudefishing" } }
```

### Settings

There is nothing to configure: the plugin declares no options (Claude Code
would list them as "not yet set" on every install), and it only ever talks
to https://claudefishing.io. The game opens by itself once per session when
an interactive terminal session starts, or the desktop app or VS Code
attaches (a phone never opens it; the server skips it while a game window is
already connected, one was opened in the last minute, or fishing is off; and
it never opens when you chose the browser link). To
keep it from doing that, set `CLAUDEFISHING_AUTO_OPEN` to `0` (or `false`,
`no`, `off`) in your shell or in the `env` block of `~/.claude/settings.json`
(the desktop app reads the latter):

```json
{ "env": { "CLAUDEFISHING_AUTO_OPEN": "0" } }
```

Mods are enabled by default in supported Claude Code versions. Update Claude
Code if `/fishing` is unknown, then run `/reload-plugins` or restart. Visual
status is supported in the terminal and Desktop Code tab. Other surfaces can
run hooks without displaying mod UI. The game opens in an external browser.

**Updates.** Marketplace installs do not update by themselves unless you turn
auto-update on (`/plugin` → Marketplaces → claudefishing → Enable
auto-update). By hand:

```sh
claude plugin marketplace update claudefishing && claude plugin update claudefishing@claudefishing
```

then type `/reload-plugins` (or restart Claude Code). In the desktop app, ask
Claude to run it: its shell has the app's own `claude` as
`$CLAUDE_CODE_EXECPATH`. When a newer plugin is out, the status line says
`· update available`, a toast gives that command once, and `/fishing` shows
it; when the server needs a newer one than yours, the status line says
`🎣 update the plugin to play` and the game shows an update screen.

## Usage

```
/fishing              status (same as /fishing status)
/fishing open         open the game (pairs this machine with it; turns fishing on if it was off)
/fishing open app     open it in an app window, from now on
/fishing open browser give a link to open in your own browser, from now on
/fishing off          stop reporting from every session on this machine, and close its game window
/fishing on           resume
/fishing link         a one-time code for another device to play this cat
/fishing link <code>  play the cat that code was made for, here too
/fishing unlink       go back to this machine's own cat
```

`/fishing status` shows whether fishing is on, the server and whether it
answers, whether the game window is open, your player, the devices that play
it, how many live sessions they have, the model and effort shown on your
nametag, the buff, this session's model and effort, and where the identity
file is.

### Several devices, one cat

Every machine starts with a cat of its own. `/fishing link` on a machine
prints a code (like `KQ74-MZ8P`, good once, for 10 minutes; the command to
type on the other device goes to the clipboard), and `/fishing link
KQ74-MZ8P` on another machine makes that machine play the same cat: same
fish, money, level and cosmetics. Its sessions count for the buff from then
on, and a game window it has open reopens as that cat.

If the claiming machine's own cat has caught or bought something, a question
comes first: it says what that cat has, what it is switching to and what
becomes of the old one, and offers `Switch to <cat>` or `Keep <cat>`. Nothing
is deleted: `/fishing unlink` switches a linked machine back to its own cat,
again asking first if it is the last device of a cat with progress (that cat
could not be reached again). In `claude -p` nobody can be asked, so nothing
switches.

On and off is one switch for the whole machine, kept in
`~/.claudefishing/fishing.json` beside the identity: every session reads it
every 5 seconds, whichever copy of the plugin it runs, and a new session starts
the way you left it. The server keeps the switch too. While it is off, no
session on the machine counts, not even one still running a plugin from before
0.3.0, and turning it off closes the game window the machine opened (the page
closes itself, or says fishing is off if the browser will not let it).
`/fishing off` always counts as a flip, so typing it again closes a window
opened since. `/fishing open` turns fishing back on too; the automatic open
never does, and opens nothing while fishing is off.

Sessions still on a plugin before 0.3.0 follow the switch at their next
keepalive (they read it from the plugin's store, which the plugin keeps in step
with the file), and their own `/fishing on` and `/fishing off` count as a flip
once a session on 0.3.0 reads the store. A copy of the plugin loaded by hand
keeps a store of its own: the server leaves its sessions out while fishing is
off all the same.

The status line shows one of:

| | |
| --- | --- |
| `🎣 in game` | the server answers and a game window is connected |
| `🎣 opening game` | this session just opened the game and its window has not joined yet (at most 45 s) |
| `🎣 game closed` | the server answers, no game window (`/fishing open`) |
| `🎣 offline` | the server did not answer, or no session on the machine got an answer for 2½ minutes (the game stays locked unless another session reaches it) |
| `🎣 off` | `/fishing off` |

plus ` · ⚡+11%` while the buff is on.

The first `/fishing open` asks "App window" or "Browser link" and keeps the
answer in the plugin's store (dismissed, or in `claude -p`, it opens the app
window and asks again next time). The app window opens with `open -na "Google
Chrome" --args --app=<url>` (a chromeless app window), else `open <url>`, else
`xdg-open <url>`. The browser link is printed and copied to the clipboard
instead, to open in whichever browser you like. Either way the link carries a
one-time pairing code; it works once, for two minutes.

## What it sends, and what stays local

Every request goes to `https://claudefishing.io` (in development, to a server
on the same machine) with `Authorization: Bearer <secret>`.

* **Identity.** On first use the plugin creates `~/.claudefishing/identity.json`
  (`{ secret, createdAt }`, a random 256-bit secret; the folder is mode 700,
  the file 600). It is written to a temporary file and linked into place, so
  sessions starting together all end up with the same one. It never leaves
  your machine except as that bearer token, and the server stores only hashes
  of it. Your browser never sees it: it is paired with a one-time code
  instead. Deleting the file makes you a new player; an unreadable one is
  kept as `identity.json.corrupt-<time>` and replaced. Set
  `CLAUDEFISHING_HOME=/some/dir` to keep it in `/some/dir/identity.json`
  instead (a second identity for testing).
* **`POST /api/heartbeat`** per session, at once when something changes
  (Claude starts or stops working or starts waiting on you, the model or
  effort changes, activity after 5 idle minutes), every 5 s for up to 45 s
  after the session opens the game (until the answer says its window joined),
  once when the session ends, and once when fishing goes off (again a minute
  later while the server does not answer it). Otherwise as a keepalive once
  nothing was sent for 60 s, but only from a session Claude worked in during
  the last 5 minutes (the buff's window). An idle session stays quiet unless
  no session on the machine has sent a heartbeat for 60 s, so forty idle
  threads keep the game open with one heartbeat a minute, not forty. Quiet
  sessions' status lines show the last answer any session on the machine got.
  Each heartbeat carries:

  | Field | |
  | --- | --- |
  | `sessionId` | the Claude Code session id |
  | `enabled` | `false` once, when fishing goes off |
  | `ending` | `true` once, when the session ends; after `/clear` or `/resume`, once the next conversation has sent its first heartbeat |
  | `model` | the model id the last main-loop request used (`claude-opus-5-5`), or the one `/model` switched to, else the session's |
  | `effort` | the last request's effort (`low` … `max`); null before this session's first turn, after a `/model` switch until the next request, and for a model without effort |
  | `working` | a turn or a subagent is running right now and Claude is not waiting on you |
  | `activeAgoMs` | milliseconds since Claude last started a turn, made a model request, called a tool, got a tool's result or finished a turn; null before any |
  | `modVersion` | this plugin's version (a server may refuse versions older than its minimum) |
  | `fishing` | the machine's switch, `{ on, rev }`: `rev` counts the flips, so the server keeps the newest. The answer has the server's, which wins when newer (the file was lost, say) |
  | `work` | what Claude has done in the session, as totals (below), for game mechanics; the game may use them or not |

  `work` holds numbers only, totals since its random `run` id began, which
  only grow (a `/clear` or `/resume` starts a new run):

  * model requests answered, the main loop's and subagents', and their
    tokens by kind (input, output, cache read, cache write), also by the
    model that answered (`claude-opus-5-5`), for up to 8 models;
  * main-loop turns ended, of them how many you interrupted and how many
    ended on an error or a refusal, and their total length; subagent runs
    ended;
  * tool calls by tool: Claude Code's own tools by name (`Bash`, `Read`,
    `Edit` …), every MCP tool as `mcp` and anything else as `other`, never
    which server, plugin, command, file or input; and how many different MCP
    servers were called (their names stay in the session, on your machine);
  * the status line's figures at the last measure: how full the context window
    is and its size, your plan's rate-limit windows (percent used and when each
    resets), and what the session has cost so far.

* **The machine's keepalive and last answer**, beside the identity and never
  sent anywhere: `~/.claudefishing/keepalive.json` (`{ at, sessionId }`,
  stamped before every heartbeat; a session taking the keepalive over from
  another writes a `claim` first and beats only if its claim is still there a
  second later, so idle sessions finding it due together send one heartbeat)
  and `~/.claudefishing/answer.json` (the newest heartbeat answer, which quiet
  sessions show).
* **`POST /api/pair`** `{ sessionId, reason: 'auto' | 'manual' }` when the game
  is opened. The server skips `auto` while fishing is off on the machine;
  `manual` (`/fishing open`) turns it on.
* **`POST /api/link`** `{}` on `/fishing link`; **`POST /api/link/claim`**
  `{ code, sessionId, replace }` on `/fishing link <code>` (`replace` is true
  only after you chose to switch); **`POST /api/unlink`** `{ sessionId,
  confirm }` on `/fishing unlink`.

Nothing else: no prompts, answers, code, file names, tool inputs or paths.

## Development

Use Node.js 24 LTS and install the development tools (including a local,
pinned Claude Code binary):

```sh
npm ci
npm run validate
npm test
npm run typecheck
```

The tests run through Claude Code's engine with filesystem, processes, network
and time mocked. They need no account or model call. Type checking first loads
a disposable copy to generate `.claude-plugin/types/` using the pinned Claude
Code binary. It uses a temporary identity/configuration and a closed loopback
port; it neither opens the game nor needs an account. Generated declarations
are ignored by Git. Run `npm run types:generate` to refresh them separately.

For a local game server, load this checkout with the server in the
environment:

```sh
CLAUDEFISHING_SERVER_URL=http://localhost:8790 CLAUDEFISHING_AUTO_OPEN=0 claude --plugin-dir /path/to/claudefishing
```

`CLAUDEFISHING_SERVER_URL` only takes a server on the same machine
(`localhost`, `127.0.0.1` or `[::1]`); anything else is ignored. Every request
carries the machine's secret, and a project's `.claude/settings.json` can set
environment variables, so no setting may send it to another server. Use
`CLAUDEFISHING_HOME` to choose a separate test identity (and on/off switch). To copy the mod
into an existing hot-reload session, name that session explicitly:

```sh
npm run dev:sync -- /absolute/path/to/dev-mods/<session>
```

`SERVER_URL` overrides the copy's local server. The helper never guesses the
most recent session, and refuses to replace a folder it did not create.

## HTTP contract and releases

`types/protocol.ts` is the public contract for heartbeat, pairing and device
linking. It contains no game rules, assets, storage schema or browser protocol.
The game vendors an exact copy from a pinned public commit. `release.json`
records its SHA-256, the plugin version and the stable update command.

For a release:

1. Make backward-compatible changes to the contract and hooks.
2. Run `node scripts/prepare-release.mjs MAJOR.MINOR.PATCH` to update version
   metadata and the contract hash.
3. Run validation, tests and type checking; review and publish the commit.
4. Tag that tested commit and update the game's pinned contract/release metadata.
   Only raise the server's minimum plugin version after the release is installable.

The marketplace uses the version in `plugin.json`; it does not duplicate it.
The game can deploy independently while older plugins remain compatible.

## Source and privacy

This repository contains only the Claude Code integration. Its history starts
with that integration; game/server/admin source and their history remain in a
separate private repository. The hosted game still delivers its browser code
and assets to players. No open-source license is granted by this repository.
