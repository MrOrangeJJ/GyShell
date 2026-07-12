# Deprecated Interactive TUI (historical `gyll`)

The historical interactive TUI implementation is deprecated and unsupported. The current `gyll` command name belongs to the new command-only agent CLI documented in [`cli-usage.md`](./cli-usage.md).

Desktop packages no longer bundle the TUI runtime, no longer install `gyll` or `gyll-tui` launchers, and no longer edit shell profiles. The new command CLI is installed separately.

When a user upgrades from an older desktop version that auto-installed the TUI, the desktop app removes legacy desktop-managed launcher files on startup. Existing shell profile PATH blocks are intentionally left untouched.

## 中文

历史交互式 TUI 已废弃且不再提供支持。现在的 `gyll` 命令属于新的纯命令 agent CLI，详见 [`cli-usage.md`](./cli-usage.md)。

桌面安装包不再内置 TUI 运行时，不再安装 `gyll` 或 `gyll-tui` launcher，也不再修改 shell profiles。新的纯命令 CLI 需要单独安装。

从旧版本升级的用户，启动新版桌面端时会清理旧 TUI 自动生成的 launcher 文件。已有 shell profile PATH block 会被保留。
