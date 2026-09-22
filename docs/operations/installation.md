# Fresh installation and release activation

## Release manifest

Pin service images/binaries, Fluree build/features/format, PostgreSQL versions,
model/context/shape definitions, API/event schemas, analyzer dictionaries and
object formats. Validate secrets/origins/owner credentials separately. Never use
a floating latest image to reproduce a release or infer engine compatibility
from a version string alone.

## Provisioning sequence

1. Prepare durable storage, private networks, backup destination and secret custody.
2. Provision Account/Access databases, Fluree ledgers and object namespaces with owner credentials.
3. Install models, validation profiles, reserved platform identities and minimum policy idempotently.
4. Start owner services, then relay/worker consumers with known checkpoints.
5. Verify exact contract versions, readiness, representative allowed/denied commands and recoverability.
6. Enable public routing and then nonessential asynchronous workloads within budgets.

Partial provisioning retains a durable operation and can resume. Re-running startup
does not reset user-owned settings or create duplicate identities. New installs
use source-native data and controlled fixtures; no old-system transfer is required.

## Upgrades

Classify data-format, semantic, API and index compatibility. Back up and qualify
restore before incompatible changes. Stage conversion/reindex, validate and activate
under fences. Mixed-version services follow declared compatibility, not optimism.
Failed upgrade stops dependent activation and keeps the last valid generation.
Rollback across incompatible storage requires its qualified restore path.
