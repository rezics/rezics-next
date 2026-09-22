# Controlled execution and hosting design questions

Package resolution, installation planning and update/rollback are selected.
Running untrusted hooks/builds or hosting persistent tools requires a concrete
executor profile in addition to catalog/dependency metadata.

Define runtime/image identity, filesystem mounts, network destinations, credentials,
CPU/memory/time/output limits, cancellation and durable effect/receipt boundaries.
Execution grants name the requesting principal/Agent, environment, artifact and
capability revision. Source text or tool output cannot widen those grants.

Separate local controlled installation, remote jobs and persistent hosting. For
each admitted profile, test isolation escapes at its intended boundary, secret
redaction, interrupted activation, uncertain external effects, metering and kill.
Select the sandbox mechanism from measured requirements; ordinary process/container
separation alone must not be described as a proven hostile-code isolation boundary.

Persistent hosting additionally needs endpoint ownership, credential rotation,
tenant resource admission, updates, monitoring and cost/recovery contracts.
Public tools expose the same REST/MCP authority rules as other integrations.
Resolve these choices before that rollout; they do not block metadata, dependency
solving or controlled non-executing conversion tests.
