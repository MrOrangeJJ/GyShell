# @gyshell/backend

Single-source backend package for GyShell runtimes.

Contains:

- Gateway/agent/runtime services
- Command policy core + adapters
- Skill runtime core + adapters
- MCP runtime core + adapters
- Backend domain types/contracts

`apps/electron` and `apps/gybackend` are runtime shells that compose this package.

Terminal runtime services own Activities, transient connection status, durable
visible history, and command transcripts. Tab configuration and terminal history
use separate stores; renderer layout stays in `packages/ui`. See
[Terminal Views and History](../../docs/terminal-views.md) for persistence,
retention, recovery, and testing contracts.
