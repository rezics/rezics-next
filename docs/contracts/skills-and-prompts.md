# Skill, Prompt and MCP content

## Native content and package identity

Skills and Prompts are independently maintained content with Work/Main Version,
contributions, exact revisions and releases. A Skill package has a manifest,
directory/file identities, entry content, declared dependencies and runtime/tool
requirements. A Prompt has parameter schemas, examples, input/output expectations,
model/tool applicability and exact content. Embedded assets use ordinary media.

MCP software/project, package release, deployment endpoint and an observed server
capability set are different resources. Reaching a URL does not prove ownership,
protocol compatibility or permission to invoke it. Record observation time and
server/tool schema versions without making observations permanent guarantees.

## Operations

Create/edit/review/publish/download/export through native commands. Resolve
dependencies and installations through [package management](package-management.md).
Pin downloadable artifact integrity and preserve licenses/provenance. Import
current Agent Skills formats and repository packages with explicit residuals and
unsupported fields; do not normalize arbitrary folders into a valid Skill.

## Execution boundary

Content ingestion and indexing do not execute instructions, hooks or MCP calls.
Execution is a separately admitted package/runtime operation with user intent,
capability ceilings, secret custody, network/filesystem limits and recoverable
run state. Persistent hosting is a separate rollout from local controlled execution.
An external tool receives only its intended credential audience.

Protocol verification uses controlled servers for tools/resources/prompts,
pagination, cancellation, errors, capability drift and authorization. Validate
context-bound full-text discovery over Skill and Prompt text without executing it.
Basis: [Agent Skills specification](https://agentskills.io/specification).
