# Deprecated Interactive TUI (historical `gyll`)

The historical interactive TUI implementation is deprecated and unsupported. The current `gyll` command name belongs to the new command-only agent CLI documented in [`cli-usage.md`](./cli-usage.md).

Desktop packages no longer bundle the TUI runtime or install `gyll-tui`. They now carry the separate command-only `gyll` executable documented above, without restoring any TUI code or shell-profile mutation.

When a user upgrades from an older desktop version that auto-installed the TUI, the desktop app removes only marker-owned legacy launcher files and the exact marker-owned shell profile PATH blocks.

## 中文

历史交互式 TUI 已废弃且不再提供支持。现在的 `gyll` 命令属于新的纯命令 agent CLI，详见 [`cli-usage.md`](./cli-usage.md)。

桌面安装包不再内置 TUI 运行时，也不再安装 `gyll-tui`。安装包现在携带的是上文所述、完全独立的纯命令 `gyll`，不会恢复任何 TUI 代码或 shell-profile 修改逻辑。

从旧版本升级时，桌面端只会删除带旧安装器 ownership marker 的 launcher，以及 marker 明确包围的旧 PATH block。
