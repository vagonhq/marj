# marj

Review your local git changes in a GitHub-style web UI — and have the conversation with the
Claude Code session you started it from. Comment on a line, Claude answers **in that thread**,
fixes the code if you asked it to, and the diff updates under you.

```
┌──────────────────────┐   comment    ┌───────────────┐   COMMENT t3 …   ┌──────────────┐
│  browser (localhost) │ ───────────► │  marj server  │ ───────────────► │ your Claude  │
│  GitHub-style diff   │ ◄─────────── │  .marj/*.json │ ◄─────────────── │ Code session │
└──────────────────────┘  SSE: reply  └───────────────┘   marj reply     └──────────────┘
```

No cloud, no separate agent, no macOS app. One CLI, one local port, MIT.

## Why

`difit` shows the diff but comments only travel one way — you copy a prompt into your agent.
Diffsmith does the round trip but is closed source and paid. marj is the round trip, open.

## Install

```bash
npm install -g marj      # or: npx marj
```

## Use it yourself

```bash
marj                     # working tree vs HEAD, plus untracked files
marj .                   # unstaged only
marj --staged            # staged only
marj a1b2c3d             # a single commit
marj main..feature       # a range
marj main feature        # two revisions
git diff | marj -        # a diff from stdin
```

The browser opens on `http://127.0.0.1:4711`. Hover a line and hit `+` to comment on it — or
**drag down the gutter** (or shift-click a second line) to select a range, exactly like on
GitHub. Then send it one of two ways:

- **Comment** (`⌘↵`) — Claude answers in the thread and **does not touch the code**.
- **Comment & fix** (`⌘⇧↵`) — Claude makes the change, then says what it changed.

The choice travels with the message (`[ask]` / `[fix]` in the agent's inbox), so nothing is
left to the agent's guesswork. `u` toggles unified/split. The diff live-refreshes as
files change, and threads follow the code they were written against — including when the line
itself gets rewritten. Threads live in `.marj/threads.json` inside the repo, so closing the
server does not lose the conversation.

## Use it with Claude Code

Install the skill once:

```bash
mkdir -p ~/.claude/skills/marj && cp "$(npm root -g)/marj/skill/SKILL.md" ~/.claude/skills/marj/
```

Then in any repo, tell Claude `/marj`. It starts the server, opens the browser and arms a
watch. From then on every comment you write in the browser lands in that session, in order,
and its answer appears under the line. Ask it to fix something and it edits the file — the
diff refreshes on its own.

Under the hood the session just runs the agent-facing half of the CLI:

```bash
marj watch                  # one line per new comment, blocks in between (long-poll)
marj threads --pending      # what still owes an answer
marj show t3                # the thread plus the code around it
marj reply t3 --typing      # "Claude is typing…" in the UI
marj reply t3 --stdin       # post the answer, markdown welcome
marj resolve t3
marj delete t3
marj comment src/a.ts 42 "this returns 500" --side new
```

Any agent that can run a shell command works — there is nothing Claude-specific in the
protocol.

## Several repos at once

Every repo runs its own server: the port walks up from 4711, state lives in that repo's
`.marj/`, and the tab is titled after the repo. Running `marj` twice in the *same* repo is
refused (it prints the URL that is already serving) — `--force` overrides.

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/diff` | parsed diff |
| `GET /api/threads` · `POST /api/threads` | list / create |
| `POST /api/threads/:id/messages` | reply (`role: user` or `agent`, `intent: ask` or `fix`) |
| `PATCH /api/threads/:id` | `status`, `agentTyping` |
| `DELETE /api/threads/:id` | delete a thread |
| `GET /api/events` | SSE for the browser |
| `GET /api/agent/wait?cursor=N` | long-poll: blocks until a new comment |
| `GET /api/agent/queue` | unanswered comments, oldest first |

Bound to `127.0.0.1` only.

## Options

```
--port <n>      preferred port (default 4711, walks up if taken)
--host <h>      bind address (default 127.0.0.1)
--context <n>   diff context lines (default 5)
--no-open       do not open a browser
--no-watch      do not refresh when files change
--json          machine readable output
```

## Develop

```bash
npm install
npm run build          # dist/server + dist/client
npm test               # vitest: diff parser, anchoring, thread store
npm run dev:server     # tsc --watch
npm run dev:client     # vite on :5173, proxies /api to :4711
```

## License

MIT
