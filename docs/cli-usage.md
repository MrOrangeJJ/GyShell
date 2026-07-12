# Command CLI (`gyll`)

## English

### Purpose

The current `gyll` is a command-only control surface for agents. It is not the
historical interactive TUI. Every invocation performs one operation, writes one
JSON envelope, and exits.

It connects to the same WebSocket gateway used by mobile-web, so the desktop app
or `gybackend` must already be running with the gateway enabled.

### Build and run

From the repository root:

```bash
npm run build:cli
npm --silent run cli -- --help
npm --silent run cli -- status
```

To expose the development wrapper locally:

```bash
cd apps/cli
npm link
gyll --help
```

The npm workspace also exposes the `gyshell-cli` alias. Desktop installers expose
the canonical `gyll` command using a separately executable Node SEA; users do not
need Node.js, npm, Bun, or Electron's `ELECTRON_RUN_AS_NODE` mode.

### Installed desktop packages

- macOS: the app always contains `Contents/Resources/cli/bin/gyll`. After moving
  GyShell to an Applications folder, accept the first-run prompt or choose
  **GyShell → Install 'gyll' Command…**. This creates
  `/usr/local/bin/gyll` as a link to the app-owned binary and never edits shell
  profiles. The same menu can repair or uninstall the link.
- Windows Setup: NSIS installs `resources\\cli\\bin\\gyll.exe`, adds that exact
  directory to the user PATH, broadcasts the environment change, and removes
  only that entry on uninstall. Start a new terminal/agent process after install.
- Windows Portable: the portable artifact carries the CLI for GyShell's own local
  terminals but intentionally does not mutate PATH. Use the Setup installer when
  a global `gyll` command is required.
- Linux deb/rpm/pacman: the package owns `/usr/bin/gyll`; install, upgrade, and
  removal are handled by the package manager.
- Linux AppImage/unpacked: the app offers an explicit setup that atomically copies
  its CLI to `~/.local/bin/gyll`. It never links into the ephemeral AppImage mount
  and never edits `.profile`, `.bashrc`, or `.zshrc`. Owned copies update only
  when the bundled app version moves forward; opening an older retained AppImage
  never silently downgrades the command. If `~/.local/bin` is not already on PATH,
  the app shows the exact directory to add.

Packaged GyShell local terminals place the bundled CLI directory first after the
startup configuration of platform-default and common custom shells (bash, zsh,
fish, Nu, POSIX sh/ksh, PowerShell/cmd, and csh/tcsh), including on first launch.
Unknown shells retain the already-prepended parent PATH and log a diagnostic.

### Connection and output contract

```bash
gyll --url ws://127.0.0.1:17888 status
GYSHELL_TOKEN='<token>' gyll --url ws://192.168.1.8:17888 status
gyll --pretty session list
```

Global configuration:

- `--url`, `GYSHELL_URL`, or `GYSHELL_WS_URL`
- `--token` or `GYSHELL_TOKEN`; the environment variable avoids shell history
- `--timeout` or `GYSHELL_TIMEOUT_MS`
- `GYSHELL_WS_PORT` / `GYBACKEND_WS_PORT` for the default local URL

Success is written to stdout:

```json
{ "ok": true, "command": "status", "data": { "pong": true, "ts": 123 } }
```

Failure is written to stderr. Exit codes are `2` for usage, `3` for connection,
`4` for RPC/runtime failure, and `5` for timeout.

### Common agent workflows

```bash
# Sessions
gyll session list
gyll session create
gyll session get --session-id '<id>'
gyll session rename --session-id '<id>' --title 'Investigate failure'
gyll session delete --session-id '<id>'

# Submit and inspect work
gyll chat send --message 'Run tests and fix failures'
gyll chat send --session-id '<id>' --message 'Continue' --wait
printf '%s' 'Long prompt' | gyll chat send --stdin --wait
gyll chat wait --session-id '<id>' --wait-timeout 600000
gyll chat stop --session-id '<id>'

# Images (repeat --image)
gyll chat send --message 'Inspect these screenshots' --image one.png --image two.jpg

# Approval is always explicit
gyll approval reply --approval-id '<id>' --decision allow
gyll approval reply --backend-message-id '<id>' --decision deny

# Terminal tabs
gyll terminal list
gyll terminal create --type local --cwd /workspace
gyll terminal create --type ssh --connection-id '<saved-connection-id>'
gyll terminal write --terminal-id '<id>' --data 'npm test' --enter
gyll terminal buffer --terminal-id '<id>' --from-offset 0

# Runtime configuration
gyll profile list
gyll profile use --profile-id '<id>'
gyll skill enable --name '<name>'
gyll tool disable --kind mcp --name '<name>'
gyll policy add --list asklist --rule 'git push*'
```

`chat send` returns immediately by default. Add `--wait` to wait until the
session completes, needs approval, or reaches `--wait-timeout`. A timeout returns
the latest session with `status: "running"`; it does not stop the task. The old
headless spellings remain as convenience aliases: `gyll run <message>` means
`chat send --wait`, and `gyll hook <message>` means `chat send`.

### Settings and raw RPC

`settings get` recursively redacts credential-shaped fields. Use
`--include-secrets` only when the caller truly needs them.

```bash
gyll settings get
gyll settings set --json '{"memory":{"enabled":true}}'
gyll rpc gateway:ping
gyll rpc session:get --params '{"sessionId":"<id>"}'
```

`rpc` is an explicit escape hatch and can return sensitive data when invoking a
low-level method such as `settings:get`; callers own that risk.

## 中文

### 定位

现在的 `gyll` 是面向 agent 的纯命令控制面，不是历史上的交互式 TUI。
每次调用只执行一个操作、输出一个 JSON envelope，然后退出。它与 Mobile Web
使用相同的 WebSocket gateway，因此需要先启动桌面端或 `gybackend` 并启用网关。

### 构建与运行

```bash
npm run build:cli
npm --silent run cli -- --help
npm --silent run cli -- status

cd apps/cli
npm link
gyll --help
```

开发用 npm workspace 也提供 `gyshell-cli` 别名。桌面发行包提供的是规范的
`gyll` 命令，并将同一套命令代码构建为独立 Node SEA；目标机器不需要安装
Node.js、npm、Bun，也不依赖 Electron 的 `ELECTRON_RUN_AS_NODE`。

### 桌面安装包中的 CLI

- macOS：App 始终内置 `Contents/Resources/cli/bin/gyll`。先把 GyShell 移入
  Applications 目录，再接受首次启动提示，或选择
  **GyShell → Install 'gyll' Command…**；它只会创建
  `/usr/local/bin/gyll` symlink，不修改任何 shell profile。相同菜单可修复或卸载。
- Windows Setup：NSIS 把 `gyll.exe` 安装到 `resources\\cli\\bin`，精确加入用户
  PATH，并在卸载时只删除这一项。安装后需重启已有 Terminal/agent 进程。
- Windows Portable：便携包不会修改 PATH；如需全局 `gyll`，请使用 Setup 安装包。
- Linux deb/rpm/pacman：安装包直接拥有 `/usr/bin/gyll`，升级与卸载由包管理器负责。
- Linux AppImage/unpacked：用户明确同意后，App 会原子复制 CLI 到
  `~/.local/bin/gyll`，不会链接到临时 mount，也不会修改 `.profile`、`.bashrc`
  或 `.zshrc`。只有 App 版本向前升级时才会自动更新已有副本，打开保留的旧
  AppImage 不会静默降级命令。若该目录尚未位于 PATH，App 会显示需要添加的准确目录。

已打包 GyShell 会在平台默认及常见自定义 shell（bash、zsh、fish、Nu、POSIX
sh/ksh、PowerShell/cmd、csh/tcsh）完成启动配置后，再把 App 内 CLI 目录放到
Local Terminal 的 PATH 首位，因此首次启动时也可直接运行 `gyll`。无法识别的
shell 会保留父进程中已前置的 PATH，并写入诊断日志。

### 关键约定

- 默认连接 `ws://127.0.0.1:17888`。
- 推荐用 `GYSHELL_TOKEN` 传 token，避免写入 shell history。
- 成功只向 stdout 写一条 JSON；失败只向 stderr 写一条 JSON。
- 所有审批必须由 `approval reply` 显式完成，不会自动批准。
- `chat send` 默认异步返回；加 `--wait` 后等待完成、待审批或超时。
- `settings get` 默认递归脱敏；只有显式 `--include-secrets` 才返回凭据。
- `rpc` 是高级逃生口，调用者需要自行承担低层接口和敏感数据风险。

完整命令列表以 `gyll --help` 为准，上方英文部分包含常见 agent 工作流示例。
