# Repository organization

REZICS keeps executable owners and their consumers in one repository so model,
API and client changes can be reviewed together. Deployable owners remain
independent; a workspace is a dependency unit, not a release unit. Separate
repositories would require coordinated revisions for ordinary contract changes.
A global `frontend/backend/shared` layout would hide private authority and
contract ownership. Domain code belongs inside the service that owns it.

The actual TypeScript members are in root [`package.json`](../../package.json),
with Yarn resolving one [`yarn.lock`](../../yarn.lock). `apps/` contains public
sites; `services/` contains Account, Main and Content; `packages/` contains
reusable consumers; `model/` contains authored semantic definitions and the
compiler. `infra/` assembles runtime resources. The [service map](../architecture/services.md)
explains ownership, and [web organization](web-features.md) explains feature
boundaries. Access runs inside Main but owns private PostgreSQL state. The
Accounts site is the public Account origin; its protocol service remains a
separate owner.

`model/definitions/` and `model/compiler/` are authored inputs.
`generated/model/`, `generated/openapi/` and `packages/model/src/generated/`
are derivatives; `task gen` writes them and `task gen:check` rejects drift. The
[API qualification](../contracts/api.md) governs exported contracts. Do not
hand-edit generated artifacts. Root `tests/qa/` holds cross-owner journeys;
owner-local tests live with their code.

[Import rules](../../.dependency-cruiser.json) and `task check` enforce the
browser/service edge, reusable package independence, model-to-consumer direction,
and Main module entrypoint boundary. Package exports and workspace typechecks
supply additional checks. These gates do not yet prove every intended
cross-module interface or prevent every service-to-service source import; such
edges need explicit owner interfaces and new static cases as implementation
reaches them. Do not infer a completed isolation gate from this layout page.

Create a workspace or directory with its first consumer. A separate BFF, native
Cargo workspace or worker process needs an actual deployment or capability
boundary; an empty scaffold does not deliver one. The [staged plan](../plan/README.md)
owns feature scope and qualification, not this directory choice.
