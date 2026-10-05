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
* `/fishing open` opens the game in a chromeless Chrome window, and the game
  opens on its own once per session when one starts (setting `autoOpen`).

This is a Claude Code mod: `hooks/register.ts` runs inside Claude Code.
The game and server are hosted separately; installing the mod requires no game
source or build step. Requires Claude Code 2.1.287 or later; development checks
use 2.1.289. The mod adds no skills, MCP server, or model calls.

## Install

Pick one.

**One session, from a checkout**

```sh
claude --plugin-dir /path/to/claudefishing
```

**Every session, including the desktop app**: name the folder in
`CLAUDE_CODE_PLUGIN_DIRS`, in your shell or in the `env` block of
`~/.claude/settings.json` (the desktop app reads the latter):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claudefishing" } }
```

**From the marketplace** (recommended):

```sh
claude plugin marketplace add bryanlin850/claudefishing
claude plugin install claudefishing@claudefishing
```

or inside Claude Code: `/plugin marketplace add …`, then `/plugin install
claudefishing@claudefishing`.

### Settings

| Option | Default | |
| --- | --- | --- |
| `serverUrl` | `https://claudefishing.io` | The game server. The copy `npm run dev:sync -- /path/to/dev-mods/<session>` makes uses `http://localhost:8790` instead. |
| `autoOpen` | `true` | Open the game once per session when an interactive terminal session starts, or the desktop app or VS Code attaches (a phone never opens it). The server skips it while a game window is already connected or one was opened in the last minute. If the server could not be reached, it is tried again on the first heartbeat it answers. |

Set them with `/plugin configure claudefishing@claudefishing` (marketplace
install), or `echo '{"serverUrl":"https://…"}' | claude plugin configure
claudefishing@claudefishing --values-stdin`. For a `--plugin-dir` or
`CLAUDE_CODE_PLUGIN_DIRS` install, put them in settings:

```json
{ "pluginConfigs": { "claudefishing": { "options": { "serverUrl": "https://…" } } } }
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

then run `/reload-plugins` or restart Claude Code. When a newer plugin is out, the status line says
`· update available`, a toast gives that command once, and `/fishing` shows
it; when the server needs a newer one than yours, the status line says
`🎣 update the plugin to play` and the game shows an update screen.

## Usage

```
/fishing              status (same as /fishing status)
/fishing open         open the game window (pairs this machine with it; turns fishing on if it was off)
/fishing off          stop reporting from every session on this machine
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

On and off are remembered for the whole machine (the plugin's store), so a new
session starts the way you left it. `/fishing open` turns fishing back on too;
the automatic open never does, and opens nothing while fishing is off.

The status line shows one of:

| | |
| --- | --- |
| `🎣 in game` | the server answers and a game window is connected |
| `🎣 game closed` | the server answers, no game window (`/fishing open`) |
| `🎣 offline` | the server did not answer (the game stays locked unless another session reaches it) |
| `🎣 off` | `/fishing off` |

plus ` · ⚡+11%` while the buff is on.

The window opens with `open -na "Google Chrome" --args --app=<url>` (a
chromeless app window), else `open <url>`, else `xdg-open <url>`. The link
carries a one-time pairing code; it works once, for two minutes.

## What it sends, and what stays local

Every request goes to `serverUrl` with `Authorization: Bearer <secret>`.

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
  effort changes, activity after 5 idle minutes), else as a keepalive once
  nothing was sent for 60 s, and once when the session ends or you turn
  fishing off:

  | Field | |
  | --- | --- |
  | `sessionId` | the Claude Code session id |
  | `enabled` | `false` once, when you turn fishing off |
  | `ending` | `true` once, when the session ends; after `/clear` or `/resume`, once the next conversation has sent its first heartbeat |
  | `model` | the model id the last main-loop request used (`claude-opus-5-5`), or the one `/model` switched to, else the session's |
  | `effort` | the last request's effort (`low` … `max`); null before this session's first turn, after a `/model` switch until the next request, and for a model without effort |
  | `working` | a turn or a subagent is running right now and Claude is not waiting on you |
  | `activeAgoMs` | milliseconds since Claude last started a turn, made a model request, called a tool, got a tool's result or finished a turn; null before any |
  | `modVersion` | this plugin's version (a server may refuse versions older than its minimum) |

* **`POST /api/pair`** `{ sessionId, reason: 'auto' | 'manual' }` when the game
  is opened.
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

For a local game server, load this checkout with explicit configuration:

```sh
claude --plugin-dir /path/to/claudefishing \
  --settings '{"pluginConfigs":{"claudefishing":{"options":{"serverUrl":"http://localhost:8790","autoOpen":false}}}}'
```

Use `CLAUDEFISHING_HOME` to choose a separate test identity. To copy the mod
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
