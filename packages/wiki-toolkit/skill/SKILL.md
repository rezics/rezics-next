---
name: rezics-wiki
description: Build an evidenced wiki proposal from a holder's local TXT, EPUB or literal Ren’Py source, using exact locators and a compatible REZICS API or remote MCP server; continue later chapters as reviewed deltas.
license: Apache-2.0
metadata:
  spdx: Apache-2.0
---
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build a wiki from a local edition

Requires Bun 1.4.2+, the installed `@rezics/wiki-toolkit` package and an
authorized compatible API or remote MCP connection.

Use the offline toolkit for conversion and exact locations. Perform extraction,
matching and submission through the holder's agent and the platform's API. Do not
upload the source file or complete unit text to REZICS. A bundle is a proposal for
human review; validation is not publication or rights clearance.

## Discover and align

Use the server's OpenAPI or remote MCP capability discovery to find the Work, its
wiki Zone, the continuity and ordered composition occurrences (chapters/scenes).
Inspect current schemas, permitted entity types and active property/relation
definitions. Use resource IDs returned by discovery, not IDs inferred from titles,
filenames or chapter numbers. Follow pagination to completion. Confirm the edition
and align each local unit with a returned occurrence. Keep uncertain mappings
`occurrence: null`; do not attach revealed names or claims to those units.

The current intake calls are `wiki_candidates` (HTTP `POST /v1/wiki/candidates`)
and `wiki_validate` (HTTP `POST /v1/wiki/validations`). Both require the holder's
`wiki:propose` authorization and `actingSubject`. Use the agent's existing API/MCP
connection; the toolkit has no authentication or network client. Read the installed package's
`@rezics/wiki-toolkit/protocol/wiki-extraction.schema.json` for wire fields.

## Convert and extract one chapter at a time

Run `rezics-wiki units <file>`; for ambiguous TXT decoding, inspect the reported
encoding and uncertainty, then rerun with the holder's declared `--encoding`.
Each stdout line is a unit with text, ordinal, label and `rezics-locator-v1` locator.
Check proposed chapter boundaries and continuation warnings: TXT chapters over
256 KiB become multiple segments, all of which must be aligned to the same Work
part. Inputs over 128 MiB fail before extraction. For EPUB, keep ruby readings
separate from the base; for Ren’Py, keep route guards and uncertain speakers. Never treat branches
as events that all occurred or interpolation as evaluated dialogue.

Extract entities, names, relationships, events and places as atomic claims.
Distinguish narrated statements, what a speaker said, rumours and hypotheticals;
record `modality`, `continuity` and `revealedAt`. A quotation is evidence of the
statement, not proof it is true. Choose short exact quotes from unit text, without
normalizing spaces, punctuation, Unicode or line endings. Do not substitute a
summary or copied chapter for evidence.

Use the package's `parseFile(bytes, format, { encoding })` and
`parsed.locate(unit, start, end)` to narrow each unit to the chosen passage; positions
are UTF-16 indices in `unit.text`. Use `parsed.verify(locator)` or
`rezics-wiki verify <file> '<locator-json>'` to confirm the quote locally. A TXT range
uses original byte boundaries; do not compute it from UTF-8 re-encoding of a legacy
file. EPUB locators retain a short quote fallback. Script locators retain the label,
utterance ordinal and route guards. Do not send a full chapter's fallback text with
a short quote. A changed hash requires re-extraction and explicit edition alignment.

[The scripted Pride and Prejudice example](examples/pride.ts) constructs a bounded,
locally verified claim after discovery supplies the Work, Zone, continuity,
occurrence and an admitted predicate. Its `model: "none (scripted fixture)"` value is
only for that deterministic example; record your actual agent, model and local or
provider inference choice in real proposals.

## Match and validate

Call `wiki_candidates` with `{ actingSubject, target, zone, names }`, where names
carry value, language and optional entity type. Keep its matched, new, ambiguous and
unavailable outcomes. A candidate is a proposed match; confirm it before setting an
entity's `match`. Never silently unify aliases or guess unavailable identities.
Look up existing facts as well as names to avoid resubmitting accepted claims.

Build `wiki-extraction-v1` with target, zone, continuity, source provenance,
aligned units, entities and claims. Record a rights basis supported by the holder's
information, or `unknown`; a label is not clearance. Source hashes and media types
must agree with every locator. Use the occurrence where a fact/name is first
revealed, not the latest chapter processed. A later chapter may supply new evidence
for an existing entity without moving its earlier disclosure boundary.

Call `wiki_validate` with `{ actingSubject, bundle }`. Correct typed rejections:
missing alignment, stale scope, forbidden predicates, unresolved references or
quotation budgets. Current per-request limits are 256 units, 128 entities, 256 claims,
16 evidence items per claim and 1 MiB; candidate lookups accept 64 names. Passage
fields allow at most 200 code points, with a cumulative source budget enforced by
the server across accounts and Zones. Consult the live schema/policy for changes.
Split requests along chapter boundaries without treating these limits as a cap on
the entire wiki. Stop a rejected publication attempt and report its reason; do not
retry through another account, translation or Zone to evade a budget.

## Propose and continue

Discover the server's `wiki-bundle` proposal operation and its current schema.
Submit the validated bundle with the discovered authority, source position
and idempotency contract, then report the proposal/status link to the holder.
If that capability is unavailable, retain the validated bundle locally and report
that submission is pending. Never invent a submit endpoint or present a validation
preview as a published wiki.

For later chapters, discover `wiki_history` (`GET /v1/wiki/{work}/history`) and read accepted records and pending
proposals first. Keep the returned `revisions` pin, then follow `nextCursor` while
reusing that pin, reading position and scope on every page. The pin covers the
complete applied journal, including franchises with more than 64 proposals.
Submit a `wiki-bundle` candidate shaped as
`{ profile: "wiki-delta-v1", base: revisions, bundle, changes }`: `bundle` is a
validated `wiki-extraction-v1` for the new chapter, reusing confirmed resource IDs.
`changes` is empty for additions. Each correction names the accepted `claim` and
`revision`, `operation` (`amend` or `retract`), a nonblank `reason`, and the zero-based
`evidenceClaim` index of its cited claim in the new bundle. For an amendment that
claim is the replacement; for a retraction it supplies the reviewed citation and
does not publish a replacement assertion. Omission never deletes accepted claims.
A `stale_base` response requires rereading history and revising the proposal;
partial application resumes through the same decision idempotency key. Corrections
and reversals require the normal review authority. Pinned history preserves old
names and facts, with current rights withholding; a changed export manifest needs
a fresh seal of those pins. Persist
proposal IDs and receipts only through the server or the holder's existing workflow;
the toolkit creates no ledger or worker process.

## Strict local mode

When the holder wants no provider to see the source, use a local model for extraction.
Keep source reads and conversion on the holder's machine; disable provider-backed
agent tools that can read those files. An offline converter alone does not make a
cloud agent private. REZICS receives only the approved proposal records and bounded
quotes. The toolkit has no telemetry or fetches, and never executes source scripts.
Protected input fails plainly: do not install or recommend decryption, key recovery,
protection-bypass plugins or runtime hooks as a fallback.

The skill follows the [Agent Skills specification](https://agentskills.io/specification).
