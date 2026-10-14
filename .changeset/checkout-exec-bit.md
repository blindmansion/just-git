---
"just-git": patch
---

Checkout applies the executable bit of `100755` entries through the new optional `FileSystem.chmod`, and `status`/`diff` report mode-only changes (`old mode 100755` / `new mode 100644`) instead of silently committing them.
