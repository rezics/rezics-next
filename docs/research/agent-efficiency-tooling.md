# Agent-efficiency tooling re-evaluation

Reviewed 2026-09-26–27. Savings were not measured before adoption. The
review identified test selection, output volume, image rebuilding and late
defects as plausible agent-time costs. The [Taskfile](../../Taskfile.yml),
[affected selector](../../scripts/qa/affected.ts),
[static checks](../../scripts/static/) and
[Goal controller](../../scripts/goal/goalctl.ts) own current behavior.

## Adopted and deferred reasons

Affected test selection reaches beyond Bun's import-only changed-test mode into
QA tiers and fixtures. Compact Bun output reduces passing-test noise. A
content-addressed Fuseki image avoids stale reused tags. Type-aware oxlint catches
unawaited promises; Knip exposes dead files; ast-grep checks structural rules;
Schemathesis probes API behavior beyond authored examples. Their adoption
observations do not establish measured net time savings.

Task became the command facade on 2026-09-27 when frontend workers needed a
shared stack and per-command discoverability. Aspire coordinates development
processes and exposes their health and logs; storage remains under the existing
scripts. The dated host probe saw roughly 11 seconds of preparation and 9
seconds for AppHost startup, not a general performance guarantee. The
[toolchain lock](../development/toolchain.md) gives current versions and modes.

Nx, Turbo and moon were deferred because workspace build caching did not match
the shared QA tiers. mise duplicated runtime checks; commit hooks would add
worktree latency; PGlite cannot replace tests of PostgreSQL roles, WAL and
backup. OpenAPI diff/lint tools can be revisited when an external SDK depends on
the published contract. A bulk fixture builder remains a separate data-path
optimization, not evidence of current tool savings.
