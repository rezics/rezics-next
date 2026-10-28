# Imports

## Outcome

Maintainers and community tools can convert licensed provider dumps into traceable catalogue proposals and refresh
them safely through the same API and permission model as other contributors.

## Done when

- Bangumi, VNDB, Open Library and Wikidata each have pure, revisioned converters from source records to referenced
  command proposals. Shared conversion works independently of the platform importer.
- Source readers handle their documented dump formats with bounded parsing and resumable progress.
- The importer uses ordinary bulk APIs and permissions, tracks source records and converter revisions, and produces
  new, changed and vanished-record decisions without privileged database writes.
- End-to-end fixture imports are idempotent; changed records create new proposals; suspicious mass disappearance
  stops the run rather than silently removing a catalogue.
- Refresh respects takedown and withdrawal fences, licensing and media provenance, so removed material is not
  reintroduced. Import retry and concurrency behavior preserves effect and work bounds.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes provider conversion, dump readers, import ledger, run planning, CLI/transport and API integration for the
four launch sources. No imported user posts. Recipe-site method-text import and personal-library migration are not
implied by provider mapping; follow [public scope](../scope.md). Product writes never bypass ordinary API controls.

## Ownership

Owns `packages/conversion/**` and `services/importer/**`.
[Conversion](../../packages/conversion/README.md) and [importer](../../services/importer/README.md) own source formats,
licensing rules, plan/run state and commands. Semantic owns proposal and bulk-write contracts; content owns media
fences and provenance. Correct throughput defects at the API rather than adding a private writer.

## Dependencies

Requires semantic bulk proposals, definitions and identity mapping; Access bulk permissions; content takedown and
media interfaces; and typed client routes. Specify concrete producer exports before dependent pipelines. API and
converter fixture versions change together.

## Acceptance

Use the fixture suites under `specs/imports-*.test.ts` and `specs/imported-field-outcomes.test.ts`, the conversion
package tests and `services/importer/tests/`. Include each source end to end through the API, re-import, changed
record, mass disappearance, fenced fields, bounded readers, retryable unavailability and resumed runs. Commands
and source-specific procedures live in the [importer README](../../services/importer/README.md) and package manifests.
Apply [verification](../development/verification.md); three-scale growth evidence must cover both conversion work
and the API write path. Port legacy behavior only under the repository's source-and-test rule.

## External conditions

Licensed source dumps, upstream availability and production API configuration are external inputs. Functional
acceptance uses pinned, legally usable fixtures without waiting for live provider access.
