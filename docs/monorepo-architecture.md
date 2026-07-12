# GyShell Monorepo Architecture

GyShell uses strict layering:

- `packages/*` owns implementation and runtime logic.
- `apps/*` owns composition, bootstrap, packaging, and thin runtime wrappers only.

Frontend implementation must not be placed under `packages/backend`.

## Runtime Surfaces

1. Electron desktop app (`apps/electron`)
2. Standalone backend process (`apps/gybackend`)
3. Deprecated TUI runtime (`apps/tui` wrapper + `packages/tui` core)
4. Mobile-web runtime (`apps/mobile-web` wrapper + `packages/mobile-web` core)
5. Command-only agent CLI (`apps/cli` wrapper + `packages/cli` core)

## Workspace Layout

```text
GyShell/
├── apps/
│   ├── electron/           # thin wrapper: entry/preload/build/package config
│   ├── cli/                # thin wrapper: gyll command executable/build config
│   ├── gybackend/          # thin wrapper: backend process entry
│   ├── mobile-web/         # thin wrapper: vite host + mount entry
│   └── tui/                # deprecated historical CLI wrapper
├── packages/
│   ├── backend/            # core backend runtime (agent/gateway/terminal/services)
│   ├── cli/                # command parsing, JSON output, websocket RPC client
│   ├── electron/           # electron-only implementation (main/gateway/settings/theme)
│   ├── mobile-web/         # mobile-web UI implementation
│   ├── tui/                # deprecated historical tui UI implementation
│   ├── ui/                 # desktop renderer UI implementation
│   └── shared/             # shared cross-surface models/utilities
├── docs/
│   ├── monorepo-architecture.md
│   └── build-commands.md
└── package.json
```

## Ownership Boundaries

### `packages/backend`

- Owns transport-agnostic runtime core.
- `GatewayService` is the session orchestrator and event source of truth.
- `AgentService_v2`, `TerminalService`, `UIHistoryService`, MCP/skills/policy services, and `ResourceMonitorService` live here.
- Websocket transport implementation is in backend:
  - `WebSocketGatewayAdapter`
  - `WebSocketGatewayControlService`
- Standalone bootstrap entry:
  - `packages/backend/src/runtimes/gybackend/startGyBackend.ts`

### `packages/electron`

- Owns Electron-only runtime implementation.
- Main process composition root:
  - `startElectronMain`
- Electron transport and desktop bridge:
  - `ElectronGatewayIpcAdapter`
  - `ElectronWindowTransport`
- Desktop-only companion services:
  - `MobileWebServerService` for serving bundled mobile-web assets
  - `MonitorWindowRegistry` for monitor snapshot fan-out across desktop windows
  - platform window chrome adapters (`platform/*/windowChrome.ts`)
- Electron settings/theme migration and stores:
  - `settings/*`
  - `theme/*`

### `packages/ui`

- Desktop renderer React app.
- Owns the workspace layout system, detachable sub-window behavior, cross-window drag/drop, file editor, and monitor panel.
- UI stores consume gateway updates, terminal inventory, and monitor snapshot streams.
- Handles gateway/mobile-web settings state and profile-lock/readiness sync in chat state.

### `packages/tui`

- Deprecated and unsupported TUI runtime core:
  - session state
  - composer/input workflows
  - gateway client integration
- Mirrors profile-lock/readiness events from gateway updates.

### `packages/cli`

- Command-only, non-interactive client for agents.
- Owns deterministic argument validation, JSON envelopes, exit codes, and Node websocket transport.
- Maps common mobile-web workflows to one-shot commands and keeps a raw RPC escape hatch.
- Must not depend on Electron, React, Solid, OpenTUI, or backend implementation modules.

### `packages/mobile-web`

- Mobile-first web client implementation.
- Main controller:
  - `useMobileController`
- Includes chat/session/tools/skills/terminal/settings panels.
- Supports access-token-aware gateway connection and gateway RPC access for tools, skills, terminals, and settings.

### `packages/shared`

- Shared cross-surface models and utilities.
- Currently includes shared theme definitions and terminal connection capability models used by backend, desktop UI, and packaging flows.

### `apps/*`

- Must stay thin wrappers with no business-logic duplication.
- Any reusable runtime logic must be implemented in `packages/*`.

## Runtime Boot Flow (Desktop)

The desktop runtime chain is intentionally layered:

1. `apps/electron/src/main/index.ts`
2. `packages/electron/src/main/startElectronMain.ts`
3. Create core services (`GatewayService`, terminal/filesystem/history/theme/settings, access-token service)
4. Register `ElectronWindowTransport` for desktop renderer bridge
5. Create `WebSocketGatewayControlService` and apply websocket policy
6. Create `MobileWebServerService` for bundled mobile-web hosting
7. Create `ResourceMonitorService` + `MonitorWindowRegistry`
8. Desktop renderer windows, mobile-web, and the command CLI connect through the shared gateway semantics

## Gateway and Session Invariants

- Session lifecycle is owned by `GatewayService`.
- Profile lock is set at dispatch time and released when session returns to ready state.
- UI synchronization events:
  - `SESSION_PROFILE_LOCKED`
  - `SESSION_READY`
- Terminal tab operations are exposed through transport bridges (`terminal:list`, `terminal:createTab`, `terminal:kill`, etc.).
- Monitor snapshots are produced in backend and published to interested desktop windows; the renderer only subscribes, stores, and presents them.

## WebSocket Access Policy

Policy values:

- `disabled`
- `localhost` (host resolves to `127.0.0.1`)
- `lan` (host resolves to `0.0.0.0`, but accepts only private-network IPv4 clients)
- `custom` (host resolves to `0.0.0.0`, but accepts only configured CIDR allowlists)
- `internet` (host resolves to `0.0.0.0`)

Policy is controlled by:

- App settings (`gateway.ws`)
- Environment variables in standalone backend mode (`GYBACKEND_WS_*`)

## MCP Runtime Notes

`McpRuntimeCore` stdio startup hardening:

- merges required PATH entries with existing PATH
- injects absolute command directory when command path is explicit
- uses deterministic CWD fallback:
  1. explicit config `cwd`
  2. `$HOME`
  3. `process.cwd()`

This reduces "command not found" and unstable cwd behavior for MCP servers.

## Packaging Constraints

### macOS

`dist:mac` must keep the signature workaround sequence:

1. `electron-builder --mac --dir`
2. `apps/electron/scripts/fix-mac-signatures.sh`
3. `electron-builder --mac --prepackaged ...`

### Linux

Linux desktop packaging is driven by `apps/electron/electron-builder.yml` and depends on:

- `apps/electron/scripts/after-pack-linux.mjs`
- `apps/electron/scripts/normalize-linux-artifact-name.mjs`
- `apps/electron/scripts/postinstall-linux.sh`
- icon resources under `apps/electron/materials/icons`

Desktop Linux packages carry bundled mobile-web frontend assets as extra resources. The historical CLI TUI is deprecated and must not be bundled in desktop packages. The new Node-based command CLI is built and installed separately.
