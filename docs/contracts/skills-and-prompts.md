# Skill, Prompt and MCP content

## Native content and package identity

Skills and Prompts are independently maintained content with Work/Main Version,
contributions, exact revisions and releases. A Skill package has a manifest,
directory/file identities, entry content, declared dependencies and runtime/tool
requirements. A Prompt has parameter schemas, examples, input/output expectations,
model/tool applicability and exact content. Embedded assets use ordinary media.

## REZICS package requirement sidecar

The Agent Skills manifest does not standardize package-manager dependency fields.
REZICS imports declared package requirements from the optional root file
`rezics.package-requirements.json`, preserving the original file in the Skill
inventory. Its shape is:

```json
{
  "profile": "rezics-skill-package-requirements-v1",
  "requirements": [
    { "ecosystem": "npm", "selector": "^1.2.0", "target": { "name": "tiny" }, "strength": "required" },
    { "ecosystem": "cargo", "selector": "=1.0.0", "target": { "name": "leaf", "table": "dependencies" }, "strength": "required" }
  ]
}
```

Selectors retain ecosystem-native syntax; `target` is an ecosystem-specific JSON
object retained by Hub and checked by the selected adapter. npm uses `target.name`
as the root manifest dependency key. Cargo uses `target.name` and optional
`target.table` (`dependencies` by default). Go uses `target.path`. Each
requirement stores its sidecar JSON pointer and source path. Imports admit at
most 256 requirements and 65,536 sidecar bytes. The current lock adapters are
npm, Cargo and Go. Other well-formed ecosystem names are retained as
`unsupported`, and cannot satisfy a required lock mapping until that adapter
exists. Required supported requirements must map to a resolved segment of the
same ecosystem. The adapter checks the retained root selector and requires the
selected direct dependency to have an exact artifact in that segment. The
immutable lock binds the Skill revision and exact ordinal-to-segment mappings.
Resolution and artifact integrity remain the selected ecosystem profile and
shared package-lock owners' responsibility. This is a REZICS extension to Skill
directories; it does not change the upstream `SKILL.md` format.

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
