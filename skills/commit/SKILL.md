---
name: commit
description: "Commit and push the uncommitted changes of a marj review with a well-written message. Use when the user says /marj:commit, presses 'Ask Claude to commit & push' in the review UI, or asks you in a thread or the chat to commit / push the fixes."
argument-hint: "[--no-push] [extra instructions for the message]"
---

# marj commit

The fixes you made during a review are plain uncommitted edits in the user's working tree. This
turns them into a commit — with a message you write — and pushes, through the running marj
server so the browser updates at once.

## Steps

1. See what is uncommitted and where it would land:

   ```bash
   cd <repo root> && git status --short && git diff HEAD --stat
   curl -s http://127.0.0.1:<port>/api/worktree | jq '{branch, reviewedBranch, onReviewedBranch, touched}'
   ```

   If `onReviewedBranch` is false the working tree is on a **different branch** than the one
   under review. Stop and tell the user; do not commit review fixes onto the wrong branch. They
   can switch from the *Uncommitted changes* section ("Switch to …") or you can run
   `git checkout <reviewedBranch>` / `gh pr checkout <n>` if they say so.

2. Write the message from what actually changed (`git diff HEAD`), in the conventional style the
   repo uses (`git log --oneline -10` shows it): a short imperative subject, a blank line, then a
   few lines on *why*, mentioning the review threads it answers when that helps. Do not list file
   names the diff already shows.

3. Commit and push in one go:

   ```bash
   cd <repo root> && marj commit --push -m "$(cat <<'EOF'
   fix: guard null user in getUser callers

   Review threads t3 and t5 pointed at unchecked dereferences; both call sites
   now bail out early with a 401 instead of a 500.
   EOF
   )"
   ```

   Only the paths the user names go in when they limit it: `marj commit -m "…" src/a.ts`.
   Leave out `--push` when they asked to commit only, or said `--no-push`.

4. Report in the same place the request came from (the chat, or the thread): the short sha,
   the branch, and whether it was pushed. If the push failed (no remote, no permission),
   say so — the commit still exists locally.

Never amend, rebase or force-push. Never commit with `--no-verify`. If there is nothing to
commit, say so instead of inventing a change.
