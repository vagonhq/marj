<div align="center">

# marj

### Make Claude's memory an expansion of your memory.

Review your local git changes in a GitHub-style UI — and talk to the Claude Code session that opened it, right in the diff.

Comment on a line. Claude answers **in that thread**, fixes the code if you asked, and the diff updates under you. No cloud, no second agent, no desktop app — one CLI, one local port.

[![npm](https://img.shields.io/npm/v/%40vagonhq%2Fmarj?color=2088ff&label=npm)](https://www.npmjs.com/package/@vagonhq/marj)
[![CI](https://github.com/vagonhq/marj/actions/workflows/ci.yml/badge.svg)](https://github.com/vagonhq/marj/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org)

```
┌──────────────────────┐   comment    ┌───────────────┐   COMMENT t3 …   ┌──────────────┐
│  browser (localhost) │ ───────────► │  marj server  │ ───────────────► │  your Claude │
│  GitHub-style diff   │ ◄─────────── │ ~/.marj/…json │ ◄─────────────── │  Code session│
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

The plugin adds four commands:

| Command | What it does |
| --- | --- |
| `/marj:review [target]` | register this repo with the hub (starting it if needed), open the browser, watch for your comments |
| `/marj:commit` | Claude writes a commit message from the diff, commits the review's fixes and pushes |
| `/marj:reload` | fetch from the remote (re-pull a PR head) and refresh the diff, keeping every thread |
| `/marj:reset` | end every review of the repo, wipe all its threads and chat, start clean |

### Where to run it

marj works on a **local clone**. Open Claude Code (or run `marj`) anywhere inside the repo — any
subdirectory is fine, marj finds the git root itself — and it reviews that repo. Git worktrees
work the same way: each worktree is its own root with its own state folder.

If Claude Code offers to work in an isolated worktree, say no during a review: marj watches the
checkout it was started in, and a fix made in a worktree never reaches the diff. `git worktree
list` shows what has piled up; `git worktree remove <path>` cleans one out.

marj never clones. A pull-request URL is reviewed **inside your local clone of that repo**: marj
fetches the PR's commits into it (`refs/marj/pr/<n>`) and diffs from the merge base. If you're
not inside a git repo it stops with a clear error instead of guessing where to put one — so
`cd` into the repo (or clone it where you want it) first.

### The fix loop

1. You comment on a line and press **Comment & fix**.
2. Claude edits the file. That edit is a plain **uncommitted change in your local repo** — no worktree, no copy. Reviewing the branch you're on, it shows in the diff within a second.
3. The **Uncommitted changes** section at the top lists it (badged *changed in this review*), next to any older local edits (folded).
4. Commit from there — type a message and **Commit** / **Commit & push** — or press **Ask Claude to commit & push** (same as `/marj:commit`) and let Claude write the message.

marj never commits or pushes on its own; only when you click or ask.

## What you get

🗨️ **A real conversation, in the diff.** Hover a line and hit `+`, or drag down the gutter to select a range — exactly like GitHub. Send it as **Comment** (`⌘↵`, Claude answers and leaves the code alone) or **Comment & fix** (`⌘⇧↵`, Claude makes the change, then tells you what it did). The choice travels with the message, so nothing is left to guesswork.

🧵 **Threads that follow the code.** The diff live-refreshes as files change, and every thread re-anchors to the line it was written against — even after Claude rewrites that line. Threads live in `~/.marj/repos/<repo>-<hash>/threads.json` — outside your repo, nothing added to it — so closing the server never loses the conversation.

📄 **Comment on a whole file,** not just a line — for "split this up" or "why does this exist?". The thread sits above the diff and stays put no matter how the lines move.

💬 **Review chat with "Explain these changes."** A panel on the right that walks the whole change file by file — and every `path:line` it mentions (in the chat *and* in thread replies) becomes a link that jumps the diff there and highlights the file in the sidebar. Enter sends, Shift+Enter is a newline.

↕️ **Expandable context,** like GitHub. Open the lines between hunks a click or twenty at a time, all the way to the end of the file — and comment on them too.

🔀 **Pull requests & merge-base diffs.** A branch that hasn't been rebased shows only *its* commits, not everything that landed on `develop` since — because two revisions are compared from their merge base, exactly like a PR. Paste a PR URL and marj fetches it, asks `gh` for the base and title, and reviews it like the PR page. Reviewing the branch you're **on** (`/marj:review develop`) diffs against the working tree, so it shows the whole branch *and* any uncommitted edit — a **Comment & fix** appears live, no commit or refresh.

🔍 **Find a pull request from the header.** The **PRs** button lists this repo's open pull requests; type to search every state through GitHub's own syntax (`login`, `author:me`, `1921`). Picking one opens it as its own review session, so whatever you were reviewing keeps its threads and its URL. Needs `gh` on your PATH — the same CLI marj already uses to read a PR.

📝 **Uncommitted changes, ready to commit.** Every fix lands in your local repo as a plain uncommitted edit — no worktree, no copy. A section at the top lists exactly what's not committed yet (HEAD → working tree, untracked included), badges the files changed during this review, folds pre-existing local edits, and lets you **Commit** or **Commit & push** with a message — or **Ask Claude to commit & push** and let it write the message (`/marj:commit` does the same). If you're on a different branch than the one you're reviewing, it says so and offers to switch, so a fix never lands in the wrong place.

🪟 **Panels your way.** Drag the file tree and the chat to any width, hide the file tree with `b` (chat toggles from its button), flip unified/split with `u`, mark files **Viewed** to fold them away.

🔔 **You'll know when Claude replies.** A toast slides in and a chime plays; desktop notifications fire when the tab is in the background.

🎨 **Painted with GitHub's own design system.** Colours from [`@primer/primitives`](https://github.com/primer/primitives), [Octicons](https://primer.style/octicons), and [Shiki](https://shiki.style) syntax highlighting with GitHub's themes across ~200 languages, light and dark.

## How it works

`/marj:review` is the way to use marj: Claude starts the server, watches for your comments, and answers them. Under the hood it drives these CLI commands for you — you don't run them yourself:

```bash
marj watch                  # one line per new comment, blocks in between (long-poll)
marj threads --pending      # what still owes an answer
marj show t3                # the thread plus the code around it
marj reply t3 --typing      # "Claude is typing…" in the UI
marj reply t3 <<'EOF'       # post the answer (stdin when no text given), markdown welcome
marj resolve t3
marj comment src/a.ts 42 "this returns 500" --side new
marj comment src/a.ts "this module does two unrelated things"   # whole file
marj reply chat <<'EOF'   # answer the "Explain these changes" panel
marj commit --push -m "…"   # /marj:commit — commit (and push) the uncommitted changes
marj reload                 # /marj:reload — fetch from the remote and refresh the diff
marj reset                  # /marj:reset  — stop every server and wipe .marj (start over)
```

## Several reviews at once

**One hub, one port, every repo.** The first `marj` starts a small background hub on `127.0.0.1:4711`; every later `marj` — another repo, a worktree, a second clone — registers with it and returns at once, no new process, no new port. Each review lives at `http://127.0.0.1:4711/r/<repo>/`, with its own threads, chat and file watcher; state sits outside the repo in `~/.marj/repos/<repo>-<hash>/`. Running `marj` again in a repo already under review just reuses it.

**Switching between them:** the repo name at the top left is a menu of every repo and worktree marj knows about — frontend, backend, a worktree of either. Pick one and the tab moves to that review, showing only its diff. Repos with saved reviews that aren't registered right now are listed greyed out, so you can see where to run `marj`.

`marj stop` ends one repo's review; when the last one ends, the hub exits on its own. `marj stop --all` shuts everything down at once. The hub's log is `~/.marj/hub.log`.

**Which version am I on?** The header shows it next to the logo (`v0.1.4`), and `marj version` (or `marj --version`) prints the CLI's version plus the running hub's when they differ. Plugin users always get the latest release on the next `marj` start (via `npx @latest`, a few minutes after publish); a hub left running from an older version is replaced automatically the next time you run `marj`, and every review it was serving is re-registered on the new one, so nothing goes dark.

To review two things side by side — a second branch, a PR, a clean slate — start an **isolated session** with its own threads, chat and port. It shares nothing, and starting one never stops the others:

```bash
marj --session pr-42 https://github.com/you/repo/pull/42
marj watch --session pr-42        # follow-up commands take the same flag
marj stop  --session pr-42
```

`marj --force` does the same without naming it (auto `s2`, `s3`, …).

## HTTP API

Bound to `127.0.0.1` only. One hub serves every review; a review's routes are prefixed with `/r/<id>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/hub` · `GET /api/servers` | hub status; every review for the switcher (hub level) |
| `POST /api/repos` · `DELETE /api/repos/:id` | register / end a review (what `marj` and `marj stop` call) |
| `GET /r/:id/api/diff` | parsed diff — every route below lives under `/r/<id>` |
| `GET /api/file?path=&side=` | one side of a file in full, for expanding context |
| `GET /api/threads` · `POST /api/threads` | list / create |
| `POST /api/threads/:id/messages` | reply (`role: user \| agent`, `intent: ask \| fix`) |
| `PATCH /api/threads/:id` | `status`, `agentTyping` |
| `DELETE /api/threads/:id` | delete a thread |
| `GET /api/events` | SSE for the browser |
| `GET /api/agent/wait?cursor=N` | long-poll: blocks until a new comment |
| `GET /api/agent/queue` | unanswered comments, oldest first |
| `GET /api/worktree` | uncommitted changes, current vs reviewed branch, files touched this review |
| `POST /api/commit` | `message`, optional `paths`, `push` — commit (and push) the working tree |
| `POST /api/checkout` | switch the working tree to the branch under review |
| `POST /api/reload` | fetch from the remote (and a PR head) then recompute |
| `GET /api/prs?q=` | this repo's pull requests matching `q`, for the header's PR picker (needs `gh`) |

## Options

```
--exact          compare two revisions tip to tip instead of from their merge base
--session <name> an isolated review of the same repo, with its own threads and chat
--force          a second, isolated review of a repo already under review (auto-named s2, s3, …)
--port <n>       (hub) preferred port when the hub is started (default 4711, walks up if taken)
--host <h>       (hub) bind address when the hub is started (default 127.0.0.1)
--context <n>    diff context lines (default 5)
--no-open        do not open a browser
--no-watch       do not refresh when files change
--json           machine readable output

State lives outside the repo in ~/.marj/repos/<repo>-<hash>/ (override the root with MARJ_HOME).
An older <repo>/.marj folder is moved there automatically on the next start.

Per command:
--push           (commit) push after committing; publishes the branch if it has no upstream
--pending        (threads) only threads still waiting on an answer
--resolve        (reply) mark the thread resolved afterwards
--typing         (reply) only flip the "Claude is typing" indicator
--cursor <n>     (watch) resume from a sequence number
--no-catch-up    (watch) skip comments that arrived before the watch started
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

---

<p align="center">Crafted with :heart: by humans, assisted with LLMs</p>
