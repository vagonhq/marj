<div align="center">

# marj

### Review your local git changes in a GitHub-style UI — and talk to the Claude Code session that opened it, right in the diff.

Comment on a line. Claude answers **in that thread**, fixes the code if you asked, and the diff updates under you. No cloud, no second agent, no desktop app — one CLI, one local port.

[![npm](https://img.shields.io/npm/v/%40vagonhq%2Fmarj?color=2088ff&label=npm)](https://www.npmjs.com/package/@vagonhq/marj)
[![CI](https://github.com/vagonhq/marj/actions/workflows/ci.yml/badge.svg)](https://github.com/vagonhq/marj/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org)

```
┌──────────────────────┐   comment    ┌───────────────┐   COMMENT t3 …   ┌──────────────┐
│  browser (localhost) │ ───────────► │  marj server  │ ───────────────► │  your Claude │
│  GitHub-style diff   │ ◄─────────── │  .marj/*.json │ ◄─────────────── │  Code session│
└──────────────────────┘  reply (SSE) └───────────────┘   marj reply     └──────────────┘
```

</div>

---

## Quickstart with Claude Code

Inside Claude Code, add the plugin once:

```
/plugin marketplace add vagonhq/marj
/plugin install marj@vagonhq
```

Then in any repo, just say:

```
/marj:review
```

Claude starts the server, opens the browser, and starts watching. Every comment you leave lands in that session **in order**, and its answer appears under the line. Point it at anything git can name:

```
/marj:review                                       working tree vs HEAD
/marj:review --staged                              staged changes
/marj:review develop..feature                      a branch, PR-style
/marj:review https://github.com/you/repo/pull/42   a pull request
```

Nothing to install beyond **Node ≥ 20** — the plugin puts `marj` on your PATH and fetches the CLI from npm on first use.

## What you get

🗨️ **A real conversation, in the diff.** Hover a line and hit `+`, or drag down the gutter to select a range — exactly like GitHub. Send it as **Comment** (`⌘↵`, Claude answers and leaves the code alone) or **Comment & fix** (`⌘⇧↵`, Claude makes the change, then tells you what it did). The choice travels with the message, so nothing is left to guesswork.

🧵 **Threads that follow the code.** The diff live-refreshes as files change, and every thread re-anchors to the line it was written against — even after Claude rewrites that line. Threads live in `.marj/threads.json`, so closing the server never loses the conversation.

📄 **Comment on a whole file,** not just a line — for "split this up" or "why does this exist?". The thread sits above the diff and stays put no matter how the lines move.

💬 **Review chat with "Explain these changes."** A panel on the right that walks the whole change file by file — and every `path:line` it mentions becomes a link that jumps the diff there and highlights the file in the sidebar.

↕️ **Expandable context,** like GitHub. Open the lines between hunks a click or twenty at a time, all the way to the end of the file — and comment on them too.

🔀 **Pull requests & merge-base diffs.** A branch that hasn't been rebased shows only *its* commits, not everything that landed on `develop` since — because two revisions are compared from their merge base, exactly like a PR. Paste a PR URL and marj fetches it, asks `gh` for the base and title, and reviews it like the PR page.

🪟 **Panels your way.** Drag the file tree and the chat to any width, hide either with `b` / `c`, flip unified/split with `u`, mark files **Viewed** to fold them away.

🔔 **You'll know when Claude replies.** A toast slides in and a chime plays; desktop notifications fire when the tab is in the background.

🎨 **Painted with GitHub's own design system.** Colours from [`@primer/primitives`](https://github.com/primer/primitives), [Octicons](https://primer.style/octicons), and [Shiki](https://shiki.style) syntax highlighting with GitHub's themes across ~200 languages, light and dark.

## How it works

`/marj:review` is the way to use marj: Claude starts the server, watches for your comments, and answers them. Under the hood it drives these CLI commands for you — you don't run them yourself:

```bash
marj watch                  # one line per new comment, blocks in between (long-poll)
marj threads --pending      # what still owes an answer
marj show t3                # the thread plus the code around it
marj reply t3 --typing      # "Claude is typing…" in the UI
marj reply t3 --stdin       # post the answer, markdown welcome
marj resolve t3
marj comment src/a.ts 42 "this returns 500" --side new
marj comment src/a.ts "this module does two unrelated things"   # whole file
marj reply chat --stdin     # answer the "Explain these changes" panel
```

## Several reviews at once

Every repo runs its own server (the port walks up from 4711, state lives in that repo's `.marj/`). Running `marj` twice in the same repo reuses the running one instead of duplicating it.

To review two things side by side — a second branch, a PR, a clean slate — start an **isolated session** with its own threads, chat and port. It shares nothing, and starting one never stops the others:

```bash
marj --session pr-42 https://github.com/you/repo/pull/42
marj watch --session pr-42        # follow-up commands take the same flag
marj stop  --session pr-42
```

`marj --force` does the same without naming it (auto `s2`, `s3`, …).

## HTTP API

Bound to `127.0.0.1` only.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/diff` | parsed diff |
| `GET /api/file?path=&side=` | one side of a file in full, for expanding context |
| `GET /api/threads` · `POST /api/threads` | list / create |
| `POST /api/threads/:id/messages` | reply (`role: user \| agent`, `intent: ask \| fix`) |
| `PATCH /api/threads/:id` | `status`, `agentTyping` |
| `DELETE /api/threads/:id` | delete a thread |
| `GET /api/events` | SSE for the browser |
| `GET /api/agent/wait?cursor=N` | long-poll: blocks until a new comment |
| `GET /api/agent/queue` | unanswered comments, oldest first |

## Options

```
--exact          compare two revisions tip to tip instead of from their merge base
--session <name> an isolated review with its own .marj/sessions/<name>/ state
--port <n>       preferred port (default 4711, walks up if taken)
--host <h>       bind address (default 127.0.0.1)
--context <n>    diff context lines (default 5)
--no-open        do not open a browser
--no-watch       do not refresh when files change
--json           machine readable output
```

## Develop

```bash
npm install
npm run build          # dist/server + dist/client
npm test               # vitest: diff parser, anchoring, thread store, targets, expand
npm run dev:server     # tsc --watch
npm run dev:client     # vite on :5173, proxies /api to :4711
```

## License

[MIT](./LICENSE) — built at [Vagon](https://github.com/vagonhq) by [Sezer İstif](https://github.com/sezeristif).
