# Personal MyAnimeList import

Web owns this signed-in Library journey at `/library/import-mal`. Commerce owns native preview, review, guarded
apply, cancellation, deletion, matching, XML parsing and retained evidence. Web binds the installed importer and the
existing subject suggestion, current-question, own-vote, source-admission, visit and departure authorities. It does not
parse XML, fetch MyAnimeList, create an alternate vote writer or merge this source with VNDB.

Decision: keep is the default; adopt or clear uses the reviewed native question and units, score consent is separate
from status and source-admission consent, and the native score receipt stays distinct from a fresh current-vote read.

The upload identifier, current page, row drafts, question observation, readbacks and results stay in the mounted visit.
They never enter URLs, persistent browser storage, logs or public metadata. Viewer, account, credential, locale or
target changes retire private display, drafts and callbacks. Uncertain delivery custody remains in memory per sender
so an A/B/A visit can retry the exact command with its original sender, encrypted credential custody, CSRF token, key
and operands. Custody retains only the command, source-consent choices, upload id and (for a later uncertain
source-admission command) the bounded acknowledged apply result; it does not retain full pages or a second evidence
copy.

## Mounted methods and effects

The route uses the installed `KernelClient.libraryImports.mal` methods: `$preview.post`, `({ id }).get`,
`({ id }).review.post`, `({ id }).apply.post`, `({ id }).cancel.post` and `({ id }).delete`. A preview is sent once;
after acknowledgement the file bytes are dropped. A replacement upload deletes its previous native document first.
Anime retains `mal_anime` / `https://myanimelist.net/anime`; manga retains `mal_manga` /
`https://myanimelist.net/manga`. Target suggestions assist display and search; only the explicit UUID saved in review
is identity.

| Step                       | Request and effect                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload and preview         | `POST :preview` with `{ xml }` and the idempotency key. XML remains local until submit; native owns parsing and the 2 MiB decoded, 4 MiB wire, depth-16 and 500-row limits.                                                                                                                                                                                          |
| Page                       | `GET :id?after=` returns one page of at most 20 rows, including native review guards, score currentness, score outcomes and any supplied `currentScoreVote`. Web passes those fields through intact.                                                                                                                                                                 |
| Review                     | `POST :id/review` with `{ row, target, skip, replace, labels?, score? }`. Labels retain exact source indices. Score selection is keep by default; adoption requires an explicit native-unit choice. MAL zero, missing, invalid and unknown values remain visible and cannot become an adopted vote. Clearing is a separate action.                                   |
| Apply                      | `POST :id/apply` with `{ confirm: true, rows: [{ row, version, fields }] }`. `fields` selects `status` and reviewed `tags` independently; `score` is included only after separate consent bound to row, target, question, choice, replacement and review version. Existing vote replacement requires its own explicit choice.                                        |
| Source evidence            | Existing source-observation command runs only after `outcome.applied` includes `status`, and only after privacy and timestamp admission checks. MAL source evidence is independent of both effects. A known failed admission can retry the retained command; unknown delivery uses its exact command and saved sender credentials.                                   |
| Target suggestion          | The existing `CopyEditionPicker` calls `searchContentSubjects` after a 250 ms valid user-entered search. MAL row titles are not prefilled; only a deliberately selected subject UUID becomes the review target.                                                                                                                                                      |
| Current question           | Each deliberate question read calls the existing `readRatingQuestion` reader once. Web shows the real question label, meaning, grain, revision, scale and units.                                                                                                                                                                                                     |
| Current own vote           | Review pages reuse native `currentScoreVote`. Each Refresh calls the existing exact subject/question `readOriginalOwnVote` point reader once. Results show the apply score receipt separately; after an acknowledged apply, older current readings are discarded and Refresh is available for the inspected target. No per-row Web hydration or directory scan runs. |
| Retained source and labels | Expanding original source calls `source.get` once. Reopening a handle makes one page GET; each target with label outcomes gets one exact `libraryLabelAssignments` read. These calls never settle an uncertain import command.                                                                                                                                       |
| Cancel and discard         | Native cancel stops later dispatch while acknowledged effects remain. Delete clears the upload's retained evidence. The existing single departure decision is preserved.                                                                                                                                                                                             |

The upload screen can reopen one of the three retained native uploads using its private handle. The page exposes that
handle only in the mounted visit and reads exact original XML lazily through the mounted `source.get`; it never parses
the XML. Native reads reauthorize before disclosure. The handle and XML stay out of URLs, browser storage and logs.

## Retained tag adoption

The existing review accepts optional `labels` with exact native source indices and owned ID/revision or proposed-name
targets. Web consumes `tagEvidence` and shows native selection states; it never tokenizes rendered tags. Apply includes
`tags` only for an explicitly reviewed selection and preserves omission for status-only or score-only work. Explicit
status deselection survives the saved review and confirmation, so labels and score remain independent. Results show
native per-value outcomes, assignment identities and remaining source indices. A separate exact canonical Subject
assignment read reports current facts after acknowledgement and does not settle uncertain dispatch. Native limits,
reservations, expiry, authorization and cancellation remain authoritative; see the
[tag adoption owner](../../../docs/library-import-mal-labels.md).

Confirmation separates status effect, retained source evidence, score effect and source admission. Results also separate
the overall row outcome, whether status was applied, the score receipt and any later current-vote reading. A state result
does not imply a score result. Exact supplied native reasons (including `atomic_guard_unavailable`) remain visible.
Unavailable or stale score review can return to the existing deliberate fresh-review path by choosing the score again
and saving a new review. Changing target clears the score choice and exact vote readback; native units and replacement
must be selected for the new target before saving. If a command loses delivery, the visit locks new mutations and exact
Retry resends the retained command. A point read never resolves uncertain command delivery.

Web makes one preview command per upload, one page GET for page zero and each page load, and one review POST plus a
page GET for each deliberate row review. After an uncertain apply is acknowledged by exact Retry, Web makes one GET
for its containing page to recover bounded row metadata and use any fresh supplied `currentScoreVote`. Each apply
command contains at most 20 rows. Source admission makes one existing exact-target observation command per eligible
state-applied row after confirmation. Target search uses the shared debounced subject suggestion only after valid
user input. Web adds one existing question read per deliberate question action and one exact own-vote point read per
Refresh action. Direct acknowledged apply does not fetch every row; a supplied current reading is reused, otherwise
the current vote remains unavailable until the person refreshes that target. Score receipts never count as
current-vote reads. Cancel and delete each call their existing single native command.

Unknown exports retain native malformed, size and DTD/entity handling. Original state and source-admission controls,
unique target resolution, cancel/delete/discard, seven-day evidence expiry and native cleanup/recovery remain in force.
Retained uploads remain capped at three; pages and apply batches remain 20 rows; rows have at most 64 fields. Reviewed
vote evidence remains inside the existing 48 MiB retained document and 512 KiB result limits. No raw XML is kept after
ownership transfer, no private payload is put in URLs or storage, and no crawl or second evidence store is added.

The focused Web test covers default keep, MAL zero versus native zero, explicit native units and replacement, clear,
separate score and source consent, stale review replacement, target replacement, mixed state/score outcomes, exact retry,
fresh point readback, A/B/A private-state retirement, and score input, guarded observation, applied receipt and original
authorization preservation through the native boundary adapter.

## Producer boundary

This base's generated client route declaration still lags the native score review shape. Web derives common DTOs from
`KernelClient`, then carries the documented score input, version-one guard, conditional admission, applied score
outcome and current reading through a narrow typed seam without rebuilding or dropping them. The native owner remains
responsible for positive guarded admission and its receipt; Web already consumes either a positive result or the exact
supplied unavailable reason through the same flow. The current producer can return `atomic_guard_unavailable`; this
is shown verbatim and leaves status and source effects visible. Native, signed-in browser and full importer acceptance
remain with their existing owners and controller.

The native caller-cost account is in [personal MAL import](../../../docs/library-import-mal.md). Its bounded page,
guard, conditional vote command, receipt, journal and transaction work are unchanged by the Web composition.
