/**
 * The upstream git version just-git aims to be byte-compatible with.
 *
 * This is the *emulated* git version — distinct from just-git's own product
 * version (`VERSION` in `src/git.ts`). It's what belongs in git-compatible
 * output that upstream stamps with its own version, e.g. the `-- \n<version>`
 * signature footer `git format-patch` emits. The oracle suite compares just-git
 * against this git release (see `test/oracle`).
 */
export const GIT_EMULATED_VERSION = "2.53.0";
