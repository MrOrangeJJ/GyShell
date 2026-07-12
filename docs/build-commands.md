# Build Commands

This page maps root scripts, packaging targets, and release helpers to their runtime ownership.

## Root Scripts (`package.json`)

### Development

- `npm run dev`
  - Build mobile-web once, then launch Electron dev mode.
- `npm run dev:electron`
  - Electron dev mode (`apps/electron/electron.vite.config.ts`).
- `npm run dev:mobile-web`
  - Mobile-web dev server (`apps/mobile-web` wrapper, implementation in `packages/mobile-web`).
- `npm --silent run cli -- <command>` / `npm --silent run dev:cli -- <command>`
  - Run the command-only agent CLI directly from TypeScript source.
- `npm run start:cli -- <command>`
  - Run the built `apps/cli/dist/gyll.cjs` executable.
- `npm run start:backend`
  - Start standalone gybackend runtime (`@gyshell/gybackend`).
- `npm run start:mobile-web`
  - Preview built mobile-web assets.

### Build

- `npm run build`
  - Electron production build.
- `npm run build:electron`
  - Alias of `npm run build`.
- `npm run build:backend`
  - Build `@gyshell/gybackend` wrapper.
- `npm run build:cli`
  - Build the lightweight single-file Node CLI.
- `npm run prepare:cli-runtime -- --platform <darwin|win32|linux> --arch <x64|arm64>`
  - Turn the bundled CLI into a checksum-pinned, target-native Node SEA under the ignored `apps/electron/cli-runtime/<platform>-<arch>` directory.
- `npm run ensure:dist-target-native`
  - Prepare the native SQLite runtime for the architecture selected by generic `npm run dist` (macOS arm64, Windows x64, or the Linux host arch).
- `npm run build:mobile-web`
  - Build `@gyshell/mobile-web` wrapper.
- `npm run build:all`
  - Build Electron + backend + command CLI wrappers.
- `npm run prepare:mobile-web`
  - Copy built mobile-web assets into `apps/electron/mobile-web-runtime` so the desktop app can serve them as a bundled companion frontend.

### Quality / Tests

- `npm run typecheck`
  - Combined node/web typecheck (`tsconfig.node.json` + `tsconfig.web.json`).
- `npm run typecheck:all`
  - Root typecheck + backend + mobile-web + CLI.
- `npm run typecheck:backend`
- `npm run typecheck:cli`
- `npm run typecheck:mobile-web`
- `npm run test:cli`
- `npm run test:backend-regression`
- `npm run test:backend-extreme`
- `npm run test:layout-ui-extreme`
- `npm run test:backend-unit-extreme`
- `npm run test:desktop-cli-distribution`
  - Verify SEA packaging ownership, installer/PATH rules, setup collision handling, and bounded legacy cleanup.

### Packaging

- `npm run dist`
  - Build backend + Electron + `gyll` SEA + bundled mobile-web assets, then package with `electron-builder`.
- `npm run dist:mac`
  - macOS packaging chain:
    1. Build backend + Electron
    2. Build `gyll` and prepare the macOS arm64 SEA
    3. Build/bundle mobile-web assets
    4. `electron-builder --mac --dir`
    5. `apps/electron/scripts/fix-mac-signatures.sh`
    6. `electron-builder --mac --prepackaged dist/mac-arm64/GyShell.app`
- `npm run dist:win`
  - Build backend + Electron + Windows x64 `gyll` SEA + bundled mobile-web assets, then package Windows targets.
- `npm run dist:linux`
  - Build backend + Electron + Linux x64 `gyll` SEA + bundled mobile-web assets, then package Linux x64 targets.
- `npm run dist:linux-arm64`
  - Build backend + Electron + Linux arm64 `gyll` SEA + bundled mobile-web assets, then package Linux arm64 targets.

Linux targets configured in `apps/electron/electron-builder.yml`:

- AppImage
- deb
- pacman
- rpm

Packaging notes:

- mac packaging signs `Contents/Resources/cli/bin/gyll` as a nested binary and must keep the signature workaround sequence used by `dist:mac`.
- Linux packaging uses:
  - `apps/electron/scripts/after-pack.mjs`
  - `apps/electron/scripts/normalize-linux-artifact-name.mjs`
  - `apps/electron/cli-launchers/linux/gyll`
- Desktop packages also include:
  - bundled mobile-web frontend under `apps/electron/mobile-web-runtime`

CLI packaging notes:

- The historical `gyll` TUI is deprecated and unsupported.
- Every desktop target bundles the new command client as a target-native Node SEA under `resources/cli`.
- Node 22 LTS is pinned because its official binaries support GyShell's macOS 12 floor; archive SHA-256 values and generated architecture are validated during every build.
- Windows NSIS owns the exact CLI PATH entry; Linux deb/rpm/pacman own `/usr/bin/gyll`; macOS uses an explicit `/usr/local/bin/gyll` symlink; AppImage uses an explicit owned copy under `~/.local/bin`.
- Desktop startup removes only marker-owned launchers and PATH blocks left by the historical installer. New code never edits shell profiles or uses `setx`/WindowsApps.
- See [`cli-distribution.md`](./cli-distribution.md) for design invariants and platform lifecycle.

## Release Helper (`build.sh`)

- `./build.sh`
  - Build macOS, Windows, Linux x64, Linux arm64, and a standalone mobile-web zip.
- `./build.sh --mac`
- `./build.sh --win`
- `./build.sh --linux`
- `./build.sh --linux-x64`
- `./build.sh --linux-arm64`
- `./build.sh --mobile-web`
- `./build.sh --help`

Standalone mobile-web package output:

- `dist/GyShell.MobileWeb.<version>.zip`

## Standalone Backend Runtime (gybackend)

Runtime entry:

- `packages/backend/src/runtimes/gybackend/startGyBackend.ts`

Common environment variables:

- `GYBACKEND_WS_ENABLE`
  - Enable/disable websocket endpoint (`true`/`false`).
- `GYBACKEND_WS_HOST`
  - Host policy input (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0`, etc.).
- `GYBACKEND_WS_PORT`
  - Websocket port (default `17888`).
- `GYBACKEND_DATA_DIR`
  - Data directory override.
- `GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL`
  - Auto-create local terminal at startup (`true` by default).
- `GYBACKEND_TERMINAL_ID`
- `GYBACKEND_TERMINAL_TITLE`
- `GYBACKEND_TERMINAL_CWD`
- `GYBACKEND_TERMINAL_SHELL`

Desktop access policy modes:

- `disabled`
- `localhost`
- `lan`
- `custom`
- `internet`

Environment host override still maps through `GYBACKEND_WS_HOST`.

## Workspace Scripts (Development/Internal)

- `npm --workspace @gyshell/gybackend run build|start|typecheck`
- `npm --workspace @gyshell/cli run dev|build|start|typecheck|test`
- `npm --workspace @gyshell/mobile-web run dev|build|preview|typecheck`
- `npm --workspace @gyshell/electron run dev|build|preview`
- `npm --workspace @gyshell/backend run build|typecheck`
- `npm --workspace @gyshell/cli-core run build|typecheck`
- `npm --workspace @gyshell/tui-core run build|typecheck`
- `npm --workspace @gyshell/mobile-web-core run build|typecheck`
- `npm --workspace @gyshell/ui run build|typecheck`
- `npm --workspace @gyshell/shared run build|typecheck`
