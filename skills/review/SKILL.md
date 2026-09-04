---
description: "Open a GitHub-style review UI for local git changes and stay in the loop: the user comments on a line in the browser, you answer in that thread and fix the code. Use when the user says /marj:review or /marj, asks to review local changes together, or wants to talk about a diff line by line."
argument-hint: "[revision | a..b | PR url | --staged]"
---

# marj

`marj` serves the current repo's diff at `http://127.0.0.1:<port>` and turns every comment
the user leaves into a line on stdout that reaches you as a notification. You reply into the
same thread, and your answer appears under that line in the browser.

## 0. The `marj` command

The plugin puts `marj` on PATH (a wrapper that uses a global install if there is one, else
`npx -y @vagonhq/marj`). If `marj` is somehow missing, `npx -y @vagonhq/marj` is the same thing. If that fails
too there is no Node ≥ 20 — tell the user.

The user may pass a target after the command (`/marj:review main..feature`); use it as the
`marj` argument.

**Never work in a git worktree during a review.** Do not use `EnterWorktree` or agent
`isolation: "worktree"` while marj is running: marj diffs the checkout it was started in, so an
edit made in a worktree is **invisible** to the review, and the worktree lingers under
`.claude/worktrees/` afterwards. Make every `[fix]` in the checkout marj is watching.

**marj needs the repo locally, and runs from inside it.** Use the repo root of the current
Claude Code project (`git rev-parse --show-toplevel`); any subdirectory resolves to it, and a git
worktree is its own root. marj itself never clones.

If the target is a PR URL for a repo that is **not** cloned here, do **not** clone it on your
own initiative — a silent `git clone` into whatever directory you happen to be in leaves the
user with a repo they did not ask for, in a place they did not choose. Stop and tell them: "this
PR belongs to `owner/repo`, which isn't cloned here. Clone it where you want it (or `cd` into
your existing clone) and run `/marj:review` again from inside it." Only clone if they explicitly
say so, and then into the path they name.

## 1. Start the server

```bash
cd <repo root> && marj --json --no-open        # prints {"url":"http://127.0.0.1:4711/r/<repo>","mode":"...","reused":false,...}
```

It returns at once: the first `marj` starts a small background **hub** (one process, one port for
every repo) and registers this repo with it; later ones just register. No `run_in_background`
needed — read `url` from the output and open it:

```bash
open <url>            # macOS; xdg-open elsewhere
```

If `reused` is true the repo was already under review; the URL is the existing one.

Targets: `marj` (working tree vs HEAD, the default), `marj --staged`, `marj <commit>`,
`marj develop` (the current branch as a PR into develop), `marj develop..feature`, `marj <a> <b>`,
and a GitHub pull request: `marj https://github.com/o/r/pull/12`, `marj o/r#12`, `marj #12`
(fetches the PR head and diffs it from the merge base, like the PR page).
`marj develop` (reviewing the branch you are on) diffs the merge base against the **working
tree**, so it shows the whole branch like a PR *and* any uncommitted edits — so a `[fix]` you
make shows up live. `marj <a>..<b>` and `marj <a> <b>` name two commits and stay commit-to-commit
(an unrebased branch shows only its own commits); `--exact` compares the tips. Pass the user's
intent through; ask only if truly unclear.

## 2. Arm the watch — do this immediately after starting

```
Monitor({
  command: "cd <repo root> && marj watch",
  description: "marj review comments",
  persistent: true,
  timeout_ms: 3600000
})
```

Each notification looks like:

```
COMMENT t3 src/api/users.ts:42-45 [ask] — bu null check yeterli mi?
REPLY   t4 src/api/users.ts:51    [fix] — burada guard ekle
COMMENT t5 src/api/users.ts (whole file) [ask] — bu dosya ikiye bölünmeli mi?
```

`(whole file)` means the comment is about the file, not a line: read the whole file (or its
diff via `marj show`) before answering.

A third kind comes from the **review chat** panel on the right of the UI, which is about the
change as a whole and has no file:

```
CHAT chat [ask] — Explain what these changes do as a whole: the goal, then file by file …
```

Answer it with `marj reply chat`. See section 3a.

**The tag in brackets is the user's explicit choice, not a hint. Obey it.**

- `[ask]` — answer in the thread. **Do not touch the code.** If a change is warranted, describe
  it (a short snippet is fine) and let them ask for it. They pressed "Comment", not "Comment & fix".
- `[fix]` — make the change, then reply saying what you changed and why. If you think the change
  is wrong, don't do it silently: reply with your objection and ask.

Comments that arrived before the watch started are replayed once, oldest first. Nothing is
lost while you are busy — events queue and arrive in order.

Tell the user the URL and that you are watching. Then get on with whatever else they asked;
notifications will interrupt you.

## 3. Answer a thread

Work one thread at a time, oldest first.

```bash
marj reply t3 --typing              # shows "Claude is typing…" in the browser, do this first
marj show t3                        # the thread plus the surrounding code, > marks the commented lines
```

Read the real file too when the diff context is not enough. Then, **only if the comment came in
as `[fix]`**, edit the file with your normal editing tools. **Do not commit and do not refresh
anything** — marj watches the working tree, recomputes the diff, and re-anchors the thread to
the rewritten line on its own. Edit the actual file shown in the diff; that is the file on disk.

**Where the fix must land, and whether it will show:** marj tells you in the mode label at the
top (also `curl -s <url>/api/diff | jq -r .mode`).

- Working-tree reviews — the default `marj`, `marj .`, `marj --staged`, and `marj <base>`
  reviewing the branch you are on (`… (working tree)` in the label) — diff against the files on
  disk, so your edit appears within a second. This is the normal case.
- A committed range or PR you are **not** standing on — `marj <a>..<b>` of another branch, a
  commit, or `marj <pr-url>` — diffs commit to commit. A working-tree edit is real but **will not
  appear in that diff**. Say so in your reply: the change was made, but this review compares
  commits, so it shows once committed (or start `marj` on the working tree to fix live). Never
  keep editing trying to make it appear.

**Every edit you make is an uncommitted change in the user's local repo** — no worktree, no
copy, no commit. The browser has an **Uncommitted changes** section at the top of the diff that
lists exactly these (HEAD → working tree, plus untracked files), badges the files changed during
this review, and lets the user **Commit** or **Commit & push** with a message — or press
**Ask Claude to commit & push**, which reaches you as a `CHAT chat [fix]` asking you to commit.
So after a `[fix]`, point there: "değişiklik yukarıdaki *Uncommitted changes* bölümünde, oradan
commit'leyebilirsin ya da bana commit'le de". Do **not** commit or push on your own after a fix.
When the user *does* ask — that chat button, `/marj:commit`, or a thread saying "commit this" —
follow the `commit` skill: write the message from the diff and run
`marj commit --push -m "…"`, which commits through the server so the browser updates.

That section also warns when the working tree is on a **different branch** than the one under
review (e.g. reviewing PR #42 while on `develop`): a fix would land on the wrong branch. Read
the warning before a `[fix]` — if the branch is wrong, say so and offer to switch (the section's
"Switch to <branch>" button, or `gh pr checkout 42` / `git checkout <branch>`) rather than
editing the wrong branch.

Post the answer (heredoc keeps markdown intact):

```bash
marj reply t3 <<'EOF'
Haklısın, `user` null olabiliyor. `getUser()` çağrısından sonra guard ekledim ve
testi de güncelledim.
EOF
```

Your reply pops a toast (and a desktop notification when the tab is in the background) on the
reviewer's screen, so keep the first sentence self-contained — that is all they see at a glance.

Add `--resolve` when the thread is genuinely finished, or `marj resolve t3` later. Leave it
open if the user asked a question they still need to see answered, or if a conversation is
running.

You can also raise your own findings — they show up as normal threads:

```bash
marj comment src/api/users.ts 42 "Bu kod yolu 401 yerine 500 dönüyor" --side new
marj comment src/api/users.ts "Bu dosya hem HTTP hem DB işi yapıyor, ikiye bölünmeli"   # whole file
```

## 3a. The review chat and "Explain these changes"

The chat panel has an **Explain these changes** button that sends the English request above.
Answer in the language the user has been using with you, not necessarily English. Keep the
usual `[ask]` / `[fix]` discipline: the chat can carry `[fix]` too ("rename this everywhere").

To write the explanation, read the diff itself (the same target marj is showing):

```bash
git diff                                   # or: curl -s http://127.0.0.1:<port>/api/diff | jq
```

Structure the answer so it is useful next to the diff:

1. One or two sentences: what the change is for.
2. Then **file by file**, in the order they matter (new files, then core changes, then
   tests/docs). For each file say what was added or changed and *why*, and point at the code.
3. Risks, open questions, or things worth a closer look, if any.

**Every code reference must be `path:line` or `path:start-end` using the exact path as it
appears in the diff and line numbers from the new side of the file** — the UI turns these into
links that jump to that line and highlight the file in the sidebar. Bare paths (`src/a.ts`)
link to the file header. Wrap them in backticks; that still links. Made-up or approximate
paths do not link, so copy them from the diff.

```bash
marj reply chat --typing
marj reply chat <<'EOF'
Bu değişiklik marj'a dosya seviyesinde yorum ve bir review chat paneli ekliyor.

**`src/shared/types.ts:66-79`** — `FILE_LEVEL` ve `isFileLevel`: satırı olmayan thread'ler 0 ile işaretleniyor.
**`src/server/anchor.ts:141`** — dosya seviyesindeki thread'ler reanchor'da yerinde kalıyor.
…
EOF
```

`marj show chat` prints the whole conversation. Follow-up questions arrive as further `CHAT`
lines; answer each once, in the same thread.

## 4. House rules

- **Reply in the language the user commented in.** They write Turkish, you answer Turkish.
- Be concrete and short: what you found, what you changed. Reference symbols, not paragraphs.
- `[ask]` never edits files. `[fix]` edits and then explains. Nothing in between.
- If you disagree, say so in the thread with the reason. Don't silently change the code.
- If a `[fix]` is risky or reaches beyond the line under review, answer first and ask before doing it.
- Never reply to a thread twice for the same message. One user message → one reply.
- `marj threads --pending` lists anything you still owe an answer.

## 5. Several repos at once

Every repo joins the same hub, so reviewing two workspaces side by side is just `marj` in each
(same port, `/r/<repo>/` each) and **one Monitor per repo** for `marj watch`. Give each
watch a description naming the repo — `marj comments (vagon-core)` — because notifications
from both land in the same conversation and the thread ids (`t1`, `t2`) repeat across repos.

Every follow-up command must run in that repo's directory, since the CLI finds the repo's review
through its state folder (`~/.marj/repos/<repo>-<hash>/server.json`), derived from the repo path:

```bash
cd /path/to/repo-a && marj show t3
```

In the browser, the repo name at the top left is a menu of every repo/worktree with a marj server,
so the user can hop between them; you only need to make sure each has its own server and watch.

Starting a second `marj` in a repo that already has one reuses it and prints the running URL.
For a genuinely separate review in the same repo (a second branch, a PR, a fresh chat), start an
**isolated session** — its own threads, chat and port, nothing shared, and it never stops the
default one:

```bash
marj --session pr-42 --json --no-open <target>   # start it
marj watch --session pr-42                        # every follow-up command takes --session
marj show t1 --session pr-42
marj stop --session pr-42
```

Give the Monitor a description naming the session so its notifications are distinguishable.

## 6. Finish

`marj stop` ends this repo's review (the hub exits by itself once the last one ends; `marj stop --all`
stops everything). The threads stay in `~/.marj/repos/<repo>-<hash>/threads.json` — outside the repo — so a later
`marj` in the same repo brings the whole conversation back.
