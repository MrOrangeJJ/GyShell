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

To expose the built binary locally:

```bash
cd apps/cli
npm link
gyll --help
```

The package also exposes the `gyshell-cli` alias. Desktop packages do not install
either command and do not modify shell profiles.

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
{"ok":true,"command":"status","data":{"pong":true,"ts":123}}
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

也提供 `gyshell-cli` 别名。桌面安装包不会自动安装 CLI，也不会修改 shell profile。

### 关键约定

- 默认连接 `ws://127.0.0.1:17888`。
- 推荐用 `GYSHELL_TOKEN` 传 token，避免写入 shell history。
- 成功只向 stdout 写一条 JSON；失败只向 stderr 写一条 JSON。
- 所有审批必须由 `approval reply` 显式完成，不会自动批准。
- `chat send` 默认异步返回；加 `--wait` 后等待完成、待审批或超时。
- `settings get` 默认递归脱敏；只有显式 `--include-secrets` 才返回凭据。
- `rpc` 是高级逃生口，调用者需要自行承担低层接口和敏感数据风险。

完整命令列表以 `gyll --help` 为准，上方英文部分包含常见 agent 工作流示例。
