# Retained personal-list entry metadata

Each retained-list importer can compare one reviewed provider row with the owner's current private Library facts. The
comparison is read-only. A separate, explicit confirmation selects fields and applies them through the existing
native annotation and source-observation commands. Ordinary preview, state adoption, label adoption and date adoption
never change annotations or source observations.

The review displays the provider value, its retained source field and interpretation, the owner's note and priority,
and all current provider observations as separate values. It defaults to preserving local facts. The review binds the
owner, upload, row, provider review token, canonical Subject/profile, current entry incarnation, annotation revision,
and the source-observation revisions shown. A changed comparison must be reviewed again. Source comments are only
personal notes when the owner explicitly selects `note: adopt`; an empty, missing, unknown or unsupported note is
never converted to a clear. `clear` is an explicit native operation. Priority clear means Unranked.

## Provider and field support

| Provider | Personal note | Personal priority | Source privacy | Source created | Source updated |
|---|---|---|---|---|---|
| VNDB | `notes` / `note`, nonempty UTF-8 up to 4,096 bytes | unsupported | `private` when a recognized boolean value is retained | unsupported; `started` and `finished` are consumption dates | unsupported |
| MyAnimeList | `my_comments`, nonempty UTF-8 up to 4,096 bytes | `my_priority` values 0/1/2 with the confirmed mapping below | `my_privacy` when a recognized boolean value is retained | unsupported | retained `my_updated_at` or another recognized updated timestamp |
| Bangumi | `comment` or `notes`, nonempty UTF-8 up to 4,096 bytes | unsupported | retained `private` when a recognized boolean value is present | retained `created_at` | retained `updated_at` |
| AniList | `notes`, nonempty UTF-8 up to 4,096 bytes | unsupported; retained numeric priority has no adopted mapping | a retained boolean `private` field only | retained `createdAt` | retained `updatedAt` |

Recognized boolean privacy values are provider-specific true/false tokens. Unknown nonempty tokens remain private
unknown evidence and can be adopted only when the native provenance value can retain the exact token. Empty values,
malformed values and fields absent from a provider's retained schema stay distinguishable and are not guessed. Date-only
and timestamp strings retain their original precision and zone. AniList integer time tokens are retained as unknown
timestamp evidence without conversion. State dates such as MAL start/finish and VNDB started/finished never become
source-created/source-updated provenance.

**Decision:** MyAnimeList `my_priority` uses its retained low/medium/high values 0/1/2 and maps them to owner-local
positions 100/50/1 (low, medium, high). The review shows this mapping; adopting priority requires the explicit mapping
identifier `mal-priority-position-v1` in the confirmation. All other retained numeric priorities remain unsupported.

Native priority is an owner-local position from 1 through 100, with 1 highest and null unranked. The MyAnimeList map is
coarse and may tie with existing positions; the owner chooses whether to replace the current value. The original
provider value remains in the retained upload evidence. No provider rating, rank or state is used to derive priority.

The native source-observation command admits privacy, source-created and source-updated atomically. For a new
observation, all three values must be representable and explicitly selected, so the owner never adopts unselected
known values or fabricates `absent` for an unsupported field. With an existing observation, selected fields can be
corrected independently while unselected fields use `unchanged`. An explicit native clear requires an existing
observation. A provider with only a subset of the provenance fields therefore supports those fields for review and
correction when that observation already exists; it cannot create a partial native observation.

## Review, confirmation and result

Each importer adds a bounded metadata review, read and apply method to its existing upload. Review requires the row's
current provider review token and an explicit Subject choice. It returns a fresh metadata token; the private read shows
the current native values and mapped provider values. Confirmation sends that token and up to five unique field
operations (`adopt` or `clear`). `adopt` takes only the exact retained value shown by that review. Priority adoption
also requires its displayed mapping identifier. No caller-supplied note, priority or provenance value is accepted.

The metadata ledger is stored with the provider's existing upload row and is capped at eight reviews per row. It is
removed by the existing upload deletion, expiry and account-erasure owners. A successful or stale receipt is retained
through one refresh so an old retry can return its original field results without confirming the new token. Pending
effects must be retried or resolved before a new review can replace them.

Native annotation changes are one revision-guarded command for the selected note and priority fields. Provenance
changes are one revision-guarded command for the selected source-observation fields. These are separate commands;
partial success is reported per field, with `applied`, `stale`, `unsupported`, `unattempted` or `failed` outcomes.
Lost acknowledgements replay the original native command key and operands. A refreshed token cannot reuse an earlier
outcome as confirmation. Cancellation stops new native commands and preserves admitted commands; there is no
cross-command rollback. Removing upload evidence invalidates pending review but leaves admitted native facts intact.

Native effects re-read current owner authority and canonical profile through the existing command owners. Review and
confirmation also bind the current entry incarnation and source review. A changed local annotation revision, source
observation revision, provider review, profile or incarnation makes the old token stale. Source privacy is private
evidence only; it cannot authorize public disclosure. No source value or local note is sent to Search, public DTOs,
events or unredacted errors.

## Bounds and cost

The field count is `F <= 5`; the adopted note bound is `B = 4,096` UTF-8 bytes. A metadata read addresses one row and
returns at most one native personal entry with at most 32 source observations. Existing provider page sizes are the
result page bound `P`: VNDB 8, MAL 20, Bangumi 10 and AniList 20. The selected row count per metadata confirmation is
`R = 1`; repeated requests remain bounded by the upload row count and eight review tokens per row. The review body is
bounded to 1 KiB, confirmation to five operations and less than 2 KiB, and the private comparison response to 64 KiB.

Per review cost is the provider's indexed owner/upload/row read and current profile admission, plus the native personal
read of one Subject and at most 32 indexed source observations. Per apply cost adds at most one annotation command and
one source-observation command, each rechecking owner, account lifecycle and canonical profile. Result retrieval is
one indexed upload/row read; pruning is the existing bounded upload expiry/removal and account-erasure path. Thus
`C = Cfixed-authority + Csource/current-review(R,F) + R*F*Cnative-field-command + Cresult/cleanup`; unrelated owner,
account-history and provider-row populations do not add work. Native growth acceptance at 64/512/4096 retained rows
and shared checks are owned by the controller after integration.
