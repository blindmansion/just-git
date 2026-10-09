---
"just-git": patch
---

`git -c <name>=<value> <cmd>` and `git -C <path> <cmd>` now run the command with the overlay or directory applied, instead of printing help and exiting 0. An unknown leading option exits 129 with `unknown option: <opt>`. Config override keys are matched case-insensitively, as in git.
