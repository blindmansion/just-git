---
"just-git": patch
---

Support `--summary` in `git show`, `git log` and `git diff`. It prints git's create, delete, rename and mode-change lines, after `--stat`, `--shortstat` or `--numstat` output and before a `-p` patch. On its own it replaces the patch. The summary that `commit` and `merge` print now uses the same lines, so a mode change prints `mode change 100644 => 100755 <path>` instead of a delete and a create, a rename that changes the mode prints the extra mode line, and unusual paths are C-quoted as in git.

`git show` on a merge commit now prints `--stat`, `--shortstat`, `--numstat` and `--summary` against the first parent, as git does, instead of printing nothing. `git log --graph --format=<fmt>` now prints the blank line between each commit and its diff output.
