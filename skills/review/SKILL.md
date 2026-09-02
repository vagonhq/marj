---
description: "Open a GitHub-style review UI for local git changes and stay in the loop: the user comments on a line in the browser, you answer in that thread and fix the code. Use when the user says /marj:review or /marj, asks to review local changes together, or wants to talk about a diff line by line."
argument-hint: "[revision | a..b | --staged]"
---

# marj

`marj` serves the current repo's diff at `http://127.0.0.1:<port>` and turns every comment
the user leaves into a line on stdout that reaches you as a notification. You reply into the
same thread, and your answer appears under that line in the browser.

## 0. The `marj` command

The plugin puts `marj` on PATH (a wrapper that uses a global install if there is one, else
`npx -y marj`). If `marj` is somehow missing, `npx -y marj` is the same thing. If that fails
too there is no Node ≥ 20 — tell the user.

The user may pass a target after the command (`/marj:review main..feature`); use it as the
`marj` argument.

## 1. Start the server

```bash
cd <repo root> && marj --json --no-open        # prints {"port":4711,"url":"...","mode":"..."}
```

Run it with Bash `run_in_background: true`, read the `url` from its output file, then open it:

```bash
open <url>            # macOS; xdg-open elsewhere
```

Targets: `marj` (working tree vs HEAD, the default), `marj --staged`, `marj <commit>`,
`marj main..feature`, `marj <a> <b>`. Pass the user's intent through; ask only if truly unclear.

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
```

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
as `[fix]`**, make the change with your normal editing tools — the browser refreshes the diff on
its own and the thread re-anchors to the rewritten line.

Post the answer (heredoc keeps markdown intact):

```bash
marj reply t3 --stdin <<'EOF'
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
```

## 4. House rules

- **Reply in the language the user commented in.** They write Turkish, you answer Turkish.
- Be concrete and short: what you found, what you changed. Reference symbols, not paragraphs.
- `[ask]` never edits files. `[fix]` edits and then explains. Nothing in between.
- If you disagree, say so in the thread with the reason. Don't silently change the code.
- If a `[fix]` is risky or reaches beyond the line under review, answer first and ask before doing it.
- Never reply to a thread twice for the same message. One user message → one reply.
- `marj threads --pending` lists anything you still owe an answer.

## 5. Several repos at once

Each repo gets its own server (its own port, its own `.marj/`), so you can review two
workspaces side by side: start `marj` in each and arm **one Monitor per repo**. Give each
watch a description naming the repo — `marj comments (vagon-core)` — because notifications
from both land in the same conversation and the thread ids (`t1`, `t2`) repeat across repos.

Every follow-up command must run in that repo's directory, since the CLI finds the server
through `.marj/server.json` under the repo root:

```bash
cd /path/to/repo-a && marj show t3
```

Starting a second `marj` in a repo that already has one is refused; it prints the running URL
instead. Use `marj --force` only if you really want two.

## 6. Finish

`marj stop` shuts the server down. The threads stay in `.marj/threads.json`, so a later
`marj` in the same repo brings the whole conversation back.
