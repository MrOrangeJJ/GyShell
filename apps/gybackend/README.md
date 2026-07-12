# gybackend

Backend runtime bootstrap workspace for GyShell (internal/development entry).

## Run

```bash
npm --workspace @gyshell/gybackend run build
npm --workspace @gyshell/gybackend run start
```

This workspace is mainly for repository development and runtime debugging. End users should use the desktop app. The historical CLI TUI is deprecated; the command-only `gyll` client can control this runtime through its websocket gateway.

## Environment Variables

- `GYBACKEND_WS_HOST` (default `0.0.0.0`)
- `GYBACKEND_WS_PORT` (default `17888`)
- `GYBACKEND_DATA_DIR` (default `./.gybackend-data` under current working directory)
- `GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL` (default `true`)
- `GYBACKEND_TERMINAL_ID` (default `local-main`)
- `GYBACKEND_TERMINAL_TITLE` (default `Local`)
- `GYBACKEND_TERMINAL_CWD` (optional)
- `GYBACKEND_TERMINAL_SHELL` (optional)
- `GYBACKEND_MODEL` (optional bootstrap model name)
- `GYBACKEND_API_KEY` (optional bootstrap model API key)
- `GYBACKEND_BASE_URL` (optional bootstrap model base URL)

## Notes

- gybackend delegates shared backend behavior to `packages/backend`.
- MCP runtime is active through the shared backend core.
