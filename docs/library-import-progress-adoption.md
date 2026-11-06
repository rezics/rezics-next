# Adopt retained import measures into a consumption occurrence

This contract composes the retained MAL and AniList upload journeys with the native independent scalar-measure
session API. The import provider remains the owner of upload evidence, row review, confirmation, retry, cancellation,
retention and erasure. Progress sessions remain the only owner of occurrence identity, profile admission, values,
revision history and lifecycle.

Adopt a source measure only to the same-ID scalar unit admitted by the subject's current profile. Current Anime
series/season profiles admit `episode`, current Book profiles admit `page`, and MAL/AniList chapter and volume fields
remain unsupported until a current accepting profile admits those exact units. Never infer a conversion from similar
labels or values.

VNDB progress binding and readback remain a separate open Commerce decision. VNDB source values, including zero and
supplied units, stay private evidence meanwhile; they infer no session, historical activity, counted use, mapping,
profile scope or global grant. This contract does not authorize a VNDB progress writer.

## Source field and unit matrix

| Provider field                          | Subject kind                         | Exact scalar unit | Current standard profile support     |
| --------------------------------------- | ------------------------------------ | ----------------- | ------------------------------------ |
| MAL `my_watched_episodes`               | anime                                | `episode`         | Anime series and season              |
| MAL `my_read_chapters`                  | manga                                | `chapter`         | Unsupported by current Book profiles |
| MAL `my_read_volumes`                   | manga                                | `volume`          | Unsupported by current Book profiles |
| AniList `progress`                      | ANIME                                | `episode`         | Anime series and season              |
| AniList `progress`                      | MANGA                                | `chapter`         | Unsupported by current Book profiles |
| AniList `progressVolumes`               | MANGA                                | `volume`          | Unsupported by current Book profiles |
| AniList `progress` or `progressVolumes` | Other media type with retained field | none              | Unsupported                          |
| AniList `progressVolumes`               | ANIME with retained field            | none              | Unsupported                          |

The source field mapping is fixed and does not use titles, labels, dimensions or conversion. An accepting profile must
admit the exact unit as `scalar_amount` with native structure and identity `none`. The current profile also validates
the source number as supplied. A value outside its bounds is unsupported for adoption and is never clamped. Profile
activation is owned by Definitions; this flow only reads the current release. Source fields absent from the source
dialect remain absent. Empty, malformed and zero values retain their distinct parser meanings. A separate explicit
clear choice targets one existing measure and is never inferred from absent or unknown source evidence.

## Occurrence selection and confirmation

The owner may select a session from the existing subject-filtered `/v1/progressSessions` pages or request an explicit
new occurrence during row review. Each selected existing session is inspected by its supplied ID only, through the native session fact rather than
presentation labels. Review binds
owner/upload/row and source fingerprint, subject and current profile identity, session ID and immutable creation
identity, shared revision, selected units, source amounts and current amounts. The service never searches an owner's
history to guess a target. A new occurrence is not created by preview or review; the confirmed apply first uses the
native `startSession` receipt, then records each selected scalar through the native session receipt.

Existing local amounts are preserved unless that measure has an explicit overwrite choice. A clear is a distinct
explicit action. New sessions have an empty amount for each selected unit. Source dates, totals and repeat counts do
not create dates, totals, lifecycle transitions or additional historical occurrences. In particular, scalar episode
counts never create canonical Episode facts, sparse completion identifiers, completion state, holdings or votes.

Each measure reports `applied`, `cleared`, `preserved`, `missing`, `unknown`, `invalid`, `unsupported`, `stale`,
`failed` or `unattempted`, plus the exact source and current values needed by the owner. If starting an occurrence
succeeds but a later measure is refused, the result retains the admitted empty or partly updated occurrence and the
per-measure refusal. The operation does not claim a transaction across separate native effects. Stable original
native request keys and operands live in the provider's existing retained row intent/outcome; uncertain acknowledgments
retry those same commands. Cancellation blocks later effects and does not undo admitted native work. Removing upload
evidence prevents pending confirmation but does not reverse adopted progress.

## Scope and bounds

Both provider journeys retain their installed upload, review, apply, cancellation and cleanup bounds. MAL reads its
single retained document, bounded by its 500-row and 12 MiB evidence limits; AniList reads indexed row pages of at most
20 rows. Progress inspection addresses one supplied session ID; occurrence choice uses existing subject-indexed pages
of at most 100 sessions and never scans account history. Each row admits at most eight independent measures. The
native session contract allows one primary and at most seven additional measures. For selected rows `R`, measures
`M`, page size `P`, and explicitly requested starts `S <= R`, work is bounded by fixed authority plus source/occurrence
review `O(R*M)`, at most `S` native starts, at most `R*M` addressed native measure commands, at most `P` returned row
results, and finite existing cleanup. There is no runtime refill, account-wide scan, second payer or background
reconciliation.

Source derivation is separate from executed growth evidence. Acceptance must compare retained MAL/AniList sizes 64,
512 and 4096 and same-owner occurrence populations while holding `R`, `M`, `S` and `P` fixed. It must capture first,
deep and terminal result pages; existing and new occurrence review/start/update; stale refusal; uncertain start and
update replay; partial cancellation; foreign-owner denial; terminal-account denial; statement/row/buffer/byte counts;
physical native work; and cleanup. Missing counters, incompatible profiles and failed preparation do not prove growth.
The receiving controller owns native placement and those integration gates.

## Provider extensions

MAL keeps `POST /v1/libraryImports/mal/:id/review`, `/apply` and the existing paged `GET` response. Review accepts an
optional progress selection shaped as an explicit existing session ID or `{ kind: "start", primaryUnit }`, plus one
to eight unique retained fields with `adopt` or explicit `clear` actions. `replace` opts into replacing an existing
local amount and applies only to `adopt`; new sessions accept `adopt` only. Apply continues to confirm the review
version and existing source fields. The row page adds a private exact field/unit admission matrix and per-measure result.

AniList keeps `POST /v1/libraryImports/anilist/:importId:review`, `:apply` and its existing paged response. Review
accepts the same occurrence and per-measure choices alongside its existing source-field selection. Apply continues
to confirm the stored review ID. Both APIs return `stale` for a changed shared revision, current profile or selected
occurrence; separate start and measure receipts expose an admitted partial occurrence when a later measure fails.
Failed or uncertain effects retry the original native receipt and operands. A definite native invalid, denied or
unavailable write throws; it is not recorded as an uncertain retry. Native import progress actors occupy partition 0
with the selected Subject so the same-home identity mapping Rating already uses for guarded votes applies.
AniList native episode adoption uses the same `fixture.game` episode units and partition-0 home Subject as MAL, because the import fixture's Child type carries that profile.
Partition 0 identity bootstrap waits until that Subject exists so the first scan includes it. Native import tests recapture identity dirty after each Subject write, after link drain on each HTTP send once a Subject is mapped on that home, and before direct Rating apply, so Entry, Progress and vote writes cannot leave Mapping pending. A mapped home with no dirty originals and empty control pending/prepare pins stays current; recapture does not start another bootstrap generation or republish an installed epoch. They drain held prearm after mapping completes; unpublished Search/Library acknowledgements do not pin the group against later Progress writes. Mapping-complete pending jobs are current once that job's epoch is installed; native import tests then publish that job so later bootstrap can recapture dirty. A home is current for later Progress writes only after those jobs are published and control pending/prepare pins are empty. Apply commits Progress before independent state so Entry writes cannot dirty the occurrence target. A preparing identity job may change `prearm_phase`, `prearm_transaction_id` and `cancellation_transaction_id`; intent and receipts stay immutable. Later Subject writes recapture identity dirty before Progress resolves the mapping. The row page adds the private field/unit
matrix and per-measure result.

Both provider methods use the native `GET /v1/progressSessions?subjectId=...` bounded selection pages,
`GET /v1/progressSessions/:sessionId` inspection, `POST /v1/progressSessions` explicit start, and
`POST /v1/progressSessions/:sessionId:record` one-measure writes. Native start and record receipts remain the effect
authority; provider confirmation and result paging remain in the provider's existing store. Neither upload format
accepts a user-supplied account, profile pin, native command key or arbitrary source-to-unit conversion.

VNDB composes this helper from its existing `POST /v1/libraryImports/vndb/:uploadId:review` and `:apply` journey.
The review accepts either `{action: "state", ..., progress: {occurrence, measures}}` or
`{action: "progress", targetId, progress: {occurrence, measures}}`. `occurrence` is an explicit existing session ID
or `{kind: "start", primaryUnit}`; each selected measure names the retained source field and `adopt` or explicit
`clear`, with optional `replace` for an existing amount. VNDB exposes only its retained `progress` value and the
literal declared `progressMeasure`; it never derives a unit from the VN type or title. The native profile reader must
admit the exact unit before adoption. The response returns the helper's per-measure outcome and a separate current
session readback from `readPresentedSession`, including occurrence identity and revision. A source fixture pairs
`<progress unit="minute">0</progress>` with the compiled current test profile's scalar `minute` unit. Other or
missing units remain unsupported evidence unless the actual current profile admits them.
