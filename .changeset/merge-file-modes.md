---
"just-git": patch
---

`merge`, `cherry-pick`, `rebase`, `revert` and `stash apply` keep a file mode change made on either side. Before, a branch that only ran `chmod +x` merged cleanly and the result kept the old mode. Two sides adding the same path with different modes now conflict, as in git. Commit and merge summaries print `mode change 100644 => 100755 <path>` instead of a `create mode`/`delete mode` pair.
