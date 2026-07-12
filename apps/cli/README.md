# GyShell Command CLI

This workspace is the thin executable wrapper for the command-only `gyll`
client. Runtime implementation belongs to `packages/cli`.

```bash
npm run build:cli
npm --silent run cli -- status
```

See `docs/cli-usage.md` for the complete command reference.

Desktop release builds embed this same bundle into a target-specific Node SEA,
so the installed `gyll` command does not require Node.js or npm on the target
machine.
