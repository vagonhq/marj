---
name: reset
description: "Wipe a marj review and start fresh: stop every marj server for this repo, delete all threads, chat and sessions, then start a clean review again. Use when the user says /marj:reset, or asks to reset / clear / start the review over."
argument-hint: "[revision | a..b | PR url | --staged]"
---

# marj reset

Reset clears **all** review state for the current repo — every thread, the chat, and any
isolated sessions (kept in `~/.marj/repos/<repo>-<hash>/`, outside the repo) — and starts a clean review.

This throws away the whole conversation. It cannot be undone. If the user only
wants to drop a few threads, use `marj delete <id>…` instead; reset is the whole-repo wipe.

## Steps

1. Wipe and stop everything:

   ```bash
   cd <repo root> && marj reset
   ```

   This stops the default server and every session server, then deletes the repo's state folder
   (and any old `<repo>/.marj` left by earlier versions).

2. Start a clean review again, exactly like `/marj:review` — same target the user gives you
   (default is the working tree):

   ```bash
   cd <repo root> && marj --json --no-open       # prints the fresh {"url": …}
   open <url>
   ```

3. **Re-arm the watch** (a Monitor running `marj watch`), because the old server and its watch
   are gone. Follow section 2 of the `review` skill.

Tell the user it's reset and you're watching the fresh review at the new URL.
