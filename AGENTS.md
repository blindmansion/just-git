# AGENTS.md

Pure TypeScript git implementation: virtual filesystem client and embeddable git server. Runtime is [Bun](https://bun.sh).

## Docs

Start here before exploring source:

- **[docs/FILE_REFERENCE.md](docs/FILE_REFERENCE.md)** — generated map of every source file and its exports. Use this to find where things live.
- **[docs/CLI.md](docs/CLI.md)** — generated reference for all git commands and flags supported.

Both are generated (see `gen-docs` below) — never edit them by hand.

Hand-written guides: [CLIENT.md](docs/CLIENT.md), [SERVER.md](docs/SERVER.md), [REPO.md](docs/REPO.md), [PROXY.md](docs/PROXY.md), [HOOKS.md](docs/HOOKS.md), [TESTING.md](docs/TESTING.md).

To understand repo structure, use the introspection toolkit — see [test/introspection/README.md](test/introspection/README.md). Backed by the TypeScript checker, it builds import / type / call graphs plus file metrics and test↔source topology over any directory, so you can investigate layering, cycles, hubs, dead code, god-files, and test coverage/impact (run incrementally with `bun -e`). Prefer it over ad-hoc grep for architectural questions.

`docs/` is public-facing. `local-docs/` is for ephemeral planning, design notes, and todo tracking — keep work-in-progress docs there, not in `docs/`.

## Scripts

- **`bun check`** — typechecks (src + tests), formats, and lints with `--fix`. Run this after making changes. Note: this is **not** read-only; it reformats and auto-fixes files.
- **`bun test`** — runs unit and integration tests.
- **`bun gen-docs`** — regenerates `docs/FILE_REFERENCE.md` and `docs/CLI.md`. Run after changing exports or command/flag surfaces.

## Testing

Default to `bun test` for validation. just-git is also validated against real git with an oracle testing framework, but only run the oracle suite when explicitly instructed — it is slow. See **[docs/TESTING.md](docs/TESTING.md)** for methodology and how to run it (and [test/oracle/README.md](test/oracle/README.md) for details).

`bun sandbox "git init"` runs commands interactively against a real filesystem.
