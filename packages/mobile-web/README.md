# @gyshell/mobile-web-core

Core mobile web UI implementation for GyShell.

`apps/mobile-web` is a thin runtime wrapper that hosts this package with Vite.

The mobile terminal panel is a read-only monitoring surface. It polls
`terminal:getBufferDelta` for a bounded text tail and displays transient
connection status from the terminal summary. The desktop Block renderer's
Activity markers and session dividers stay on the desktop bridge, where xterm
markers can track their exact rows.
