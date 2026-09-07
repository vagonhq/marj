---
name: stop
description: "End a marj review and shut its servers down. Use when the user says /marj:stop, asks to stop / close / quit / kill marj, says marj servers are still running in the background, or is done reviewing. Plain stop ends this repo's review; --all stops the hub, every review on it, and any stray marj process left behind."
argument-hint: "[--all] [--session <name>]"
---

# marj stop

A review started from a Claude Code session ends by itself when that session exits; one started
by hand in a terminal (or with `--detach`) outlives it, as does the hub while anything is on it.
This ends them now, cleanly. Threads and chat are **kept**
in `~/.marj/repos/<repo>-<hash>/`, so a later `/marj:review` brings the conversation back.

## Which one

- **`/marj:stop`** (no argument) — end the review of the current repo only. Other repos on the
  hub keep going; when the last review ends the hub exits by itself.
- **`/marj:stop --all`** — stop everything marj on this machine: the hub and every review on
  it, plus a sweep of stray processes the hub does not know about (standalone servers from
  older versions, an orphaned hub, `marj watch` loops whose server died). Use this when the
  user says marj "is still running", "left servers open", or wants it gone completely.
- **`/marj:stop --session <name>`** — end one isolated session and nothing else.

If the user just says "stop marj" and only one repo is under review, plain `marj stop` is
right. If they complain about things lingering in the background, go straight to `--all`.

## Steps

1. Run it from inside the repo (any subdirectory works):

   ```bash
   cd <repo root> && marj stop            # or: marj stop --all   /   marj stop --session pr-42
   ```

   It prints what it stopped — the hub's pid, and with `--all` how many stray processes were
   swept (`3 servers, 1 watch`). If it says there is nothing to stop, say so; do not go
   hunting for processes by hand.

2. **Let the watch go.** Your `marj watch` Monitor prints `SERVER GONE — …` and exits on its
   own once the server is gone. If a Monitor for this repo is still listed afterwards, stop it
   (`TaskStop`). Do **not** re-arm the watch — the review is over.

3. Tell the user what ended, in one line: "review of `<repo>` stopped; threads kept" or, for
   `--all`, "hub and N reviews stopped, plus M stray processes". Mention that `/marj:review`
   restores the threads if they want to pick it up again.

## Notes

- `marj stop --all` only touches processes owned by the current user and never the shell or
  agent it was started from.
- Stopping is not resetting: nothing is deleted. To wipe threads and chat, that is `/marj:reset`.
- A hub started on port 4713 or higher usually means an old standalone server is still
  squatting on 4711; `marj stop --all` frees it, and the next `marj` comes up on 4711 again.
