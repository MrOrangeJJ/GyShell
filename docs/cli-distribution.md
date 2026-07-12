# Desktop CLI Distribution Design

`gyll` is an agent-facing command surface, so its deployment contract is closer
to Docker Desktop or LM Studio than to a developer-only npm script.

## Runtime choice

Release builds use a dedicated Node Single Executable Application (SEA). The
current command bundle and its `ws` dependency are embedded into one console
executable. This gives agents normal stdin/stdout/stderr, exit codes, waiting,
and signal behavior without requiring system Node.js.

The Electron GUI executable is deliberately not the CLI:

- a Windows Electron executable uses the GUI subsystem and does not provide the
  same console wait/stdio contract as a CUI executable;
- `ELECTRON_RUN_AS_NODE` exposes a much broader Node execution surface than this
  fixed command entry point, so the packaged Electron RunAsNode fuse is disabled;
- wrappers pointing into a movable AppImage or editing five shell profiles repeat
  the lifecycle problems of the historical implementation.

The build follows the official [Node SEA process](https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html):

1. bundle the command client to CommonJS;
2. download a pinned official Node 22 LTS archive and verify both archive and
   extracted executable SHA-256 values;
3. generate a preparation blob with snapshot/code-cache disabled for cross-target safety;
4. inject it into the matching target executable;
5. remove stale platform signatures, validate native format/architecture, then let the platform packager sign the final artifact.

Node 22 is intentional: its official macOS binary supports macOS 11+, while
Node 24 official binaries require macOS 13.5 and would violate GyShell's current
macOS 12 deployment target.

## Platform ownership

- macOS follows [Docker Desktop's documented model](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/): the signed app owns the binary and an explicit user action creates `/usr/local/bin/gyll`. A small per-user ownership record lets a later GyShell copy repair or remove the absolute link after the original app is moved, while bundle-ID checks and exact link-target matching keep foreign links untouched.
- Windows Setup owns one exact `resources\\cli\\bin` HKCU/HKLM PATH entry. It uses registry APIs without `setx`, preserves neighboring entries, broadcasts `WM_SETTINGCHANGE`, and removes its entry on upgrade/uninstall. Portable builds do not mutate PATH.
- Linux deb/rpm/pacman package manifests own `/usr/bin/gyll`; postinstall does not create an untracked launcher. Package-manager upgrade and removal therefore stay atomic.
- AppImage cannot expose a link into its ephemeral mount. With explicit consent it atomically copies the SEA to `~/.local/bin/gyll`, records a hash/version/stat ownership manifest, updates only an unchanged owned copy to a newer app version, never silently downgrades from a retained older AppImage, and refuses collisions. Lightweight stat fingerprints keep normal startup off the Electron main-thread hot path; mutating actions still verify the complete SHA-256.

Every packaged app also places its own `resources/cli/bin` first in GyShell Local
Terminal environments. The integration runs after startup configuration for the
platform defaults and common custom shells (bash, zsh including XDG `ZDOTDIR`,
fish, Nu, POSIX sh/ksh, PowerShell/cmd, and csh/tcsh). Truly unknown shells keep
the verified parent PATH and produce a diagnostic warning. No user login-shell
file is modified.

## Build-time gates

`prepare-cli-runtime.mjs` writes per-target output so parallel builds cannot
overwrite one another. `after-pack.mjs` fails packaging unless all of these hold:

- CLI executable, metadata, and Node license exist;
- Mach-O/PE/ELF platform and architecture match the Electron target;
- Windows output is a Console subsystem executable;
- POSIX execute bits are present;
- the enabled SEA sentinel is present, and the full payload checksum matches on
  every platform at the `afterPack` pre-signing boundary;
- host-native `gyll --help` succeeds.

The installer/package itself owns the external entry point. Runtime setup code
only handles explicit macOS/AppImage actions and narrowly bounded migration from
the historical marker-based installer.
