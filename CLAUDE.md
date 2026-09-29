# Hibana

Bun + TypeScript monorepo: `apps/bot` (Discord agent), `apps/api` (Elysia settings API), `apps/web` (React dashboard).

- Secrets belong in environment variables only; never commit `.env` or runtime data.
- Work directly on `main` unless the user explicitly asks for a separate branch. Do not create feature branches or separate worktrees without that instruction.
- Run `make test` after logic changes and `make ci` before pushing.
- Preserve guild / DM isolation, permission checks, bounded Docker sandboxes and independent provider credentials.
- Advisor, automatic model routing, answer verification (`verify`), and Codex fast mode (`fast`) are intentionally removed. OpenRouter provider and React navigation remain supported.
- Bot API and dashboard share the settings and model catalog in `packages/shared`.
- Explain non-obvious behavior in comments. Keep migration documentation honest about validation limits.

- For VPS operations, read `.local/deployment.json` first for the SSH target, service and paths. This machine-local file is gitignored; reuse it instead of asking for the connection details again. Never copy credentials into tracked files.
