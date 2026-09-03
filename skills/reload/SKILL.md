---
name: reload
description: "Sync a marj review with the remote and refresh the diff: git fetch, re-pull the pull-request head if reviewing a PR, then recompute what the browser shows. Use when the user says /marj:reload, or asks to sync / pull / refresh the review against the remote."
---

# marj reload

Reload pulls fresh commits from the remote and recomputes the diff, without losing any threads
or chat. Use it when the branch or PR you are reviewing has moved upstream.

```bash
cd <repo root> && marj reload
```

It runs `git fetch --all --prune`, re-fetches the pull-request head when the review is a PR, and
refreshes the diff the browser shows. Threads re-anchor to the new code on their own.

- The diff updates in the browser by itself — do not restart the server or tell the user to
  refresh the page.
- This is different from the automatic refresh marj already does when local files change; reload
  is the one that reaches out to the **remote**.
- Nothing is deleted. To wipe threads and start over, that is `/marj:reset`.

Tell the user what changed if anything did (e.g. "pulled 2 new commits on the PR"); if the fetch
failed (offline, no remote), say so and note the diff was still refreshed locally.
