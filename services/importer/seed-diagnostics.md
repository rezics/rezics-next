# Seed denial diagnostics

Decision: dump acquisition errors use the import request-diagnostic registry for locally constructed operation,
phase, status and source location. Supported operations are `dump-download` and `dump-index`; phases distinguish
network, HTTP, response and integrity failures. The source location contains only URL origin and path, excluding
userinfo, query and fragment. The original cause stays on the private Error chain. `seed-cli.ts` formats only
registered fields, and ordinary Error messages and names never become stderr text. The cross-media CLI preserves
reviewed-catalogue formatting and artifact attribution through `seedFailureDetail`.

Decision: seed HTTP diagnostics capture the first native 401/403 per transport under the importer journal's
`diagnostics/` directory. A private response body preserves exact problem bytes with status, request method/path
and SHA-256 metadata. Structured stderr reports only the HTTP operation stage, status, Subject and artifact path;
it never reports remote text, headers or credentials. This identifies the denied HTTP boundary, not an internal
authorization decision. Denials remain refusals; diagnosis changes neither grants nor replay commands.

Decision: acknowledged commands and review actions do not finish the seed. Current vocabulary publication,
independent public reads, Person merge observation, persona composition and result-file writing still precede the
result handoff. The seed and publication owners emit one bounded stderr line per fixed local phase transition,
including the active phase and remaining eligible phases; conditional phases may be skipped. A completion line
means the operation returned, not that all publication claims were available. No timer, per-record event, remote
text, source identity or credential is logged. A stopped process leaves its last started phase in the boot log.
Unexpected errors retain their original identity and private cause; the existing CLI formatter adds registered
phase metadata. Diagnostics add no journal state and never alter sealed keys, bodies or acknowledged work.

Book subphases distinguish planning, record import, credit vocabulary, creator current reads and result assembly.
An unsuccessful source generation registers only its local provider and run-status kind (including
`mass-disappearance`); its diagnostic text stays private. These fields identify a pre-write generation refusal
separately from native transport failures without exposing dump rows or remote responses.

Decision: plan books once, finish the original bounded Person-career and cover enrichment selection, then admit
complete book-family records before the first shared source import. Book-only creators do not consume the base
enrichment bounds. Admission preserves enriched existing records and the complete source generation; incomplete
families retain their ordinary gap-only result. Journal keys, missing-record checks and fresh publication reads
keep their existing contracts.

Decision: a stale dedicated page-data Definitions release is a pre-seed admission failure, not an importer retry.
The [page-data operator contract](../../tools/goal/README.md) owns explicit publication and exact-head activation of
the intended bundled release. Reconciliation preserves prepared proposal keys and all acknowledged journal work;
ordinary resume follows only after the live digest matches. Importer scopes and field validation are unchanged.

Legacy publication recovery compares an acknowledged proposal's full body independently of its request key:
Importer scopes that key before sending. Source alias, external ID, revision, digest, field group, native subject,
statement and rights remain exact. Sealed enriched proposals retain their original current bindings; recovery does
not replace them with context-free variants. Bangumi reconstruction uses the same bound native-type admission as
import. Missing receipts still require exactly one matching candidate in a complete current listing; incomplete or
ambiguous evidence cannot produce a recovered receipt. The ordinary publication pass independently checks every
retained candidate before acceptance, adoption and public readback.

Result persistence ends before `publication-completion` begins. An incomplete publication fails that strict final
check with the written artifact path and bounded omission count, while preserving the usable report. A write failure
retains its original error and `result-write` phase; neither outcome implies that omitted claims were published.

Decision: after that post-write refusal, the development seed CLI emits one versioned `Cross-media seed artifact
handoff` JSON line with the exact artifact path and omission count. It keeps the strict nonzero exit and ordinary
bounded diagnostic. The page-data runner admits only this handoff for its expected result path; source failures,
development-showcase incompleteness and old result files remain stops.
