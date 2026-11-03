# Adopt retained import measures into a consumption occurrence

This contract composes the retained MAL and AniList upload journeys with the native independent scalar-measure
session API. The import provider remains the owner of upload evidence, row review, confirmation, retry, cancellation,
retention and erasure. Progress sessions remain the only owner of occurrence identity, profile admission, values,
revision history and lifecycle.

Decision: map a source measure only to the same-ID scalar unit admitted by the subject's current profile; current Anime
series/season profiles admit `episode`, current Book profiles admit `page`, and MAL/AniList chapter and volume fields
remain unsupported until a current accepting profile admits those exact units.

## Source field and unit matrix

| Provider field | Subject kind | Exact scalar unit | Current standard profile support |
| --- | --- | --- | --- |
| MAL `my_watched_episodes` | anime | `episode` | Anime series and season |
| MAL `my_read_chapters` | manga | `chapter` | Unsupported by current Book profiles |
| MAL `my_read_volumes` | manga | `volume` | Unsupported by current Book profiles |
| AniList `progress` | ANIME | `episode` | Anime series and season |
| AniList `progress` | MANGA | `chapter` | Unsupported by current Book profiles |
| AniList `progressVolumes` | MANGA | `volume` | Unsupported by current Book profiles |
| AniList `progress` or `progressVolumes` | Other media type with retained field | none | Unsupported |
| AniList `progressVolumes` | ANIME with retained field | none | Unsupported |

The source field mapping is fixed and does not use titles, labels, dimensions or conversion. An accepting profile must
admit the exact unit as `scalar_amount` with native structure and identity `none`. The current profile also validates
the source number as supplied. A value outside its bounds is unsupported for adoption and is never clamped. Profile
activation is owned by Definitions; this flow only reads the current release. Source fields absent from the source
dialect remain absent. Empty, malformed and zero values retain their distinct parser meanings. A separate explicit
clear choice targets one existing measure and is never inferred from absent or unknown source evidence.

## Occurrence selection and confirmation

The owner may select a session from the existing subject-filtered `/v1/progressSessions` pages or request an explicit
new occurrence during row review. Each selected existing session is inspected by its supplied ID only. Review binds
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
Failed or uncertain effects retry the original native receipt and operands. The row page adds the private field/unit
matrix and per-measure result.

Both provider methods use the native `GET /v1/progressSessions?subjectId=...` bounded selection pages,
`GET /v1/progressSessions/:sessionId` inspection, `POST /v1/progressSessions` explicit start, and
`POST /v1/progressSessions/:sessionId:record` one-measure writes. Native start and record receipts remain the effect
authority; provider confirmation and result paging remain in the provider's existing store. Neither upload format
accepts a user-supplied account, profile pin, native command key or arbitrary source-to-unit conversion.
