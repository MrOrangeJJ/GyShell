export const CLI_HELP = `GyShell command CLI (gyll)

Usage:
  gyll [global options] <resource> <action> [options]
  gyll run [options] <message>       Legacy alias for chat send --wait
  gyll hook [options] <message>      Legacy alias for chat send

Global options:
  --url <ws-url>       Gateway URL (default: ws://127.0.0.1:17888)
  --token <token>      Access token; prefer GYSHELL_TOKEN to avoid shell history
  --timeout <ms>       Connection and RPC timeout (default: 15000)
  --pretty             Pretty-print JSON output
  --help, -h           Show this help

Commands:
  status
  session list
  session get       --session-id <id>
  session create
  session rename    --session-id <id> --title <title>
  session delete    --session-id <id>
  session branch    --session-id <id> --message-id <backend-message-id>
  session rollback  --session-id <id> --message-id <backend-message-id>

  chat send [--session-id <id>] [--message <text> | --stdin] [--image <path> ...]
            [--mode auto|normal|inserted] [--wait] [--wait-timeout <ms>]
  chat wait         --session-id <id> [--wait-timeout <ms>]
  chat stop         --session-id <id>
  approval reply    (--approval-id <id> | --backend-message-id <id>) --decision allow|deny

  terminal list
  terminal create   [--type local] [--title <title>] [--cwd <path>] [--shell <path>]
  terminal create   --type ssh --connection-id <saved-id> [--cols <n>] [--rows <n>]
  terminal write    --terminal-id <id> (--data <text> | --stdin) [--enter]
  terminal resize   --terminal-id <id> --cols <n> --rows <n>
  terminal buffer   --terminal-id <id> [--from-offset <n>]
  terminal reconnect --terminal-id <id>
  terminal close    --terminal-id <id>

  profile list | profile use --profile-id <id>
  skill list | skill reload | skill enable|disable --name <name>
  tool list | tool reload
  tool enable --kind mcp|built-in --name <name> [--ack-experimental-risk]
  tool disable --kind mcp|built-in --name <name>
  memory get | memory set (--content <text> | --file <path> | --stdin)
  agent-setting list | agent-setting save
  agent-setting apply --profile-id <id> [--ack-experimental-risk]
  agent-setting overwrite|delete --profile-id <id>
  policy list
  policy add|delete --list allowlist|denylist|asklist --rule <rule>
  settings get [--include-secrets]
  settings set (--json <object> | --file <path> | --stdin)
  rpc <method> [--params <object> | --file <path> | --stdin]

Environment:
  GYSHELL_URL, GYSHELL_TOKEN, GYSHELL_TIMEOUT_MS
  GYSHELL_WS_PORT or GYBACKEND_WS_PORT may override the default local port.

Output:
  Commands write one JSON envelope to stdout. Errors write one JSON envelope to stderr.
  No command prompts for input or automatically approves a permission request.
  --ack-experimental-risk explicitly confirms experimental-tool enablement when required.
`;
