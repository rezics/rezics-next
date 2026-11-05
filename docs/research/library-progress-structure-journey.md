# Progress when structure, editions or profiles change

Research evidence, accessed 31 October 2026; local source observed at `cd671664d5`.
This report recommends a journey for adoption into the existing Library owner contracts. It does not adopt
behavior, activate a profile, or establish runtime, native, full-row privacy, visual or promoted-main proof.

## Answer and scope

Keep the original session, accepted profile pin, optional version-subject reference and exact recorded values.
Show what those values mean when that meaning is available; otherwise show permitted raw history and explain
what cannot be verified. Offer recording only under the existing original-meaning and current-admission rules.
Let the person explicitly abandon an active session or start another session with an allowed pair and, where
supported, an explicitly selected version. Neither action converts earlier progress.

The crucial distinction is that **a profile release pins vocabulary and validation, not a content structure**.
Today's sparse IDs are session-local; a cursor is bounded opaque text plus a numeric position. Neither is a
verified chapter, episode or EPUB location. There is no current basis for checking old IDs against a new table
of contents, reporting particular units as deleted, or offering an automatic continuation point in another edition.
An honest manual-progress journey can close this design gap without implementing those capabilities.

This is a focused continuation of [Library abstraction](library-abstraction.md),
[Web Library design](web-library-design.md) and [shelf activity](library-shelf-activity.md), not another Library
survey. Their separation of independent facts, rereads and publication is reused. The one-page
[design-status handoff](design-status-commerce.md) names this unresolved boundary; this report is evidence for
its owner, not a replacement status page. Three primary comparisons follow: BookWyrm, EPUB specifications and Komga.

Authorities remain [Library and Collections](../library-and-collections.md),
[profile consumers](../library-profile-consumers.md), the
[native module](../../services/kernel/src/library/README.md#session-start),
[Continue](../library-continue.md), [subject identity](../architecture.md) and shared
[deletion](../deletion.md). No code, owner document, frozen test or scope is changed here.

## Primary evidence and provenance

All reference code was read as untrusted data; nothing was installed, built or executed. Existing clones were
reused beneath `/home/edge/projects/rezics/rezics-next/.reference/`; source links below pin their inspected commits.
No implementation files or long passages are proposed for copying into REZICS.

| Comparison | Retained source / version                                                                                             | Licence and limits                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BookWyrm   | `shelves/bookwyrm`, commit `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`; [repository][bw-repo]                          | [Anti-Capitalist Software License 1.4][bw-licence], `LICENSE.md`; restricted source-available software, not a permissive implementation dependency.                                                                        |
| EPUB       | [CFI 1.1][cfi], IDPF Recommended Specification, 5 January 2017; [EPUB 3.3][epub], W3C Recommendation, 13 January 2026 | CFI carries IDPF copyright and restrictions on changed reproduction; EPUB 3.3 links the [W3C Software and Document License 2023][w3c-licence]. Standards were read on their official sites; no reference clone was needed. |
| Komga      | `shelves/komga`, commit `023ec905c10a35bbb8e29095420d266cd3adad60`; [repository][komga-repo]                          | [MIT][komga-licence], `LICENSE`. Live official guides supplement the pinned implementation; they need not describe exactly that commit.                                                                                    |

### BookWyrm: an edition is a target, but switching can rewrite the association

**Facts.** `bookwyrm/models/book.py` separates `Work` and `Edition`, with `Edition.parent_work` and nullable
`pages`; its book URL uses `/book/{id}`. `models/readthrough.py` stores a distinct `ReadThrough` referencing an
`Edition`, integer page/percent progress, dates and active state; `ProgressUpdate` references that readthrough.
Starting reading creates a fresh readthrough in `views/reading.py`. These are catalogue/occurrence identities,
not immutable content digests. [Book model][bw-book], [readthrough model][bw-progress], [reading actions][bw-reading].

**Facts.** The explicit POST `switch_edition` in `views/books/editions.py` finds this user's readthroughs across
the selected edition's parent work and assigns each to the new edition. It does not filter to active reads or
rescale progress in that function. This is evidence of an intentional edition-switch operation, **not** evidence
of retained immutable edition meaning. [Edition switch, lines 85–129][bw-editions].

The official [reading-status guide][bw-guide] documents second reads and visible reading dates, and makes posting
a reading-status update a choice. It does not specify cross-edition page equivalence. No sparse completed-unit
set or content-revision migration guarantee was found in the inspected models and switch path.

**Inference for REZICS.** A person needs a visible version choice and distinct reread occurrence. BookWyrm's
association rewrite is incompatible with REZICS's immutable accepted session history; borrow the explicit choice,
not its retargeting behavior. Page `120` cannot be interpreted as page `120` of another edition from this evidence.

### EPUB: a locator can be corrected, but correction is a separate semantic operation

**Facts.** CFI 1.1 §§2.2, 3.1 and 3.5 address locations within an EPUB through structural steps and offsets.
XML-ID and text assertions can detect displaced targets; correction can relocate them after changes. A failed
assertion without a recoverable target makes the reference invalid. If assertions cannot be checked, they must
be ignored. The specification encourages replacing stale CFIs with corrected ones where possible. It does not
define a person's completed-unit set or reread history. [CFI 1.1][cfi].

**Facts.** EPUB 3.3 §5.4 distinguishes the package's `unique-identifier` reference to `dc:identifier` from
`package.version`, which identifies format conformance and remains `3.0`. §5.5.5 requires `dcterms:modified`
and recommends updating it when the publication changes. Current EPUB 3.3 no longer defines the older
“release identifier” term. These metadata fields are not an immutable content hash. [EPUB 3.3][epub].

**Inference for REZICS.** Even a standardized locator needs a known target and a declared correction policy;
its numeric steps are not portable unit identity. Our `locator` string has no declared CFI syntax or resolver.
Do not parse it, correct it, or overwrite an earlier intent under this research. If a future reader supplies a
corrected location, that needs its own version-bound contract and explicit recording semantics. Deleted text,
ambiguous matches and cross-edition equivalence remain unknown here, not an implied successful migration.

### Komga: per-item progress and explicit unavailability, with a narrower recovery rule

**Facts.** `domain/model/Book.kt` has a generated string `id`, separate `number`, file URL, hashes and modification
metadata. `ReadProgress.kt` carries `bookId`, `userId`, `page`, `completed`, dates and optional `R2Locator`.
`ReadProgressDao.kt` reads by book/user and upserts the current value. In `BookLifecycle.kt`, `markReadProgress`
validates against the current media page count and sets completion at the final page; explicit mark-completed
and delete-progress operations also exist. These are independent per-book values, not a single contiguous
series prefix, and this inspected progress store is not an append-only reread-session model.
[Book][komga-book], [progress model][komga-progress], [DAO][komga-dao], [lifecycle][komga-lifecycle].

The official [progress guide][komga-read] shows separate book and series indicators and manual read/unread
actions. The [trash guide][komga-trash] documents an Unavailable indicator when files disappear, restoration
when the expected file returns, and loss of automatic restoration after emptying trash. Hash-assisted move/rename
recovery requires a retained file hash. This is concrete evidence for distinguishing temporary absence from
permanent removal; it is not a promise to align changed editions or reordered pages.

**Unknowns.** The inspected paths do not establish how arbitrary replacement content preserves old page meaning,
or a general sparse-unit migration protocol. Hash-based recovery of a moved file must not be generalized to
semantic matching of different content. No Komga matching algorithm is recommended for REZICS.

### Shared patterns and consequential differences

**Inference from the comparisons:** target identity, position and completion are separate concepts. A catalogue
edition, EPUB path or book number supplies different evidence; matching visible ordinal labels alone proves
no equivalence. All three make location/progress intelligible within a target, rather than establishing a
universal progress number transferable between publications. Source loss can be represented explicitly instead
of being mistaken for zero progress. Komga provides the concrete unavailable/recovery example.

They do **not** share REZICS's historical-preservation rule: BookWyrm repoints readthroughs, CFI recommends locator
correction, and Komga upserts per-book progress and can infer completion at the final page. Those differences
are reasons to retain the repository's explicit completion, immutable pin and append-only intent contracts.
None of these sources demonstrates a safe automatic conversion of `{1,3,7}` to a prefix or to current units.

## Current real UI → API → storage journey

This is a source inventory, not an executed journey. The source-present native session/profile/subject anchors
are reused; their existence does not prove final authorization, current source disclosure or whole-row behavior.

| Person's step           | Current Web and HTTP source                                                                                                                                                                                                | Persisted meaning and remaining boundary                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start for a subject     | `/library/progress`: `progress-page.tsx` chooses a subject and current profile pair. Kernel `POST /v1/progressSessions` accepts optional `versionSubjectId`.                                                               | `sessions.ts` observes the original and optional version subject through `readLibraryProfileSource`; the original subject's active profile supplies the private pin. Web's `ProgressStartInput` and request omit version selection. |
| Record an amount        | Session detail posts `:record` with revision, amount and idempotency key.                                                                                                                                                  | `progress_session.amount` is exact decimal text at the API; `total` was captured at creation and belongs only to scalar mode. No record field updates the total or changes mode/unit/version.                                       |
| Record a cursor         | The detail form accepts locator and position; both are sent to `:record`.                                                                                                                                                  | `locator` is bounded text, `position` an exact numeric value. The parser does not establish a publication, coordinate system or resolvable CFI. A cursor position does not assert that preceding units are complete.                |
| Record sparse IDs       | The detail form adds/removes IDs; `/completedUnits` pages the actual set; `/changes` pages intent history.                                                                                                                 | `progress_unit` keys are `(route, session_id, unit_id)`. `completedUnitCount` is maintained from actual adds/removes. `{1,3,7}` means three opaque recorded keys, never units 1 through 7.                                          |
| Read an older session   | `GET /v1/progressSessions/{id}` returns BASIC values; FULL optionally adds current disclosed subject/version summaries. Detail renders raw IDs, changes, unavailable subject labels and a missing historical-label notice. | The private `library_profile_pin` is on the session row. `sessionView`/`sessionSchema` exclude it, as required. FULL summaries do not prove accepted historical labels or content structure.                                        |
| Finish, abandon, reread | Detail confirms `:complete` or `:abandon`; start creates another session.                                                                                                                                                  | Only explicit completion sets completion evidence. Lifecycle transitions do not enumerate units. Several active sessions are legal; starting another does not alter an earlier session, entry state, holding or entitlement.        |

Local evidence: [Web reads and request types](../../apps/web/src/library/progress-reads.ts),
[start server validation](../../apps/web/src/library/progress-server.ts),
[start UI](../../apps/web/src/library/progress-page.tsx), [detail UI](../../apps/web/src/library/progress-session.tsx),
[HTTP schema and projection](../../services/kernel/src/library/progress-routes.ts),
[session commands](../../services/kernel/src/library/sessions.ts),
[parser](../../services/kernel/src/library/progress.ts),
[row types](../../services/kernel/src/library/progress-model.ts) and
[stored pin read](../../services/kernel/src/library/progress-store-session-read.sql).

### What changes today, and what does not

1. **Source reorder/delete/add.** Nothing in the session representation binds a unit to a source's ordered
   structure. These events therefore cannot safely reorder, delete or add completed keys. A retained scalar total
   is not refreshed from a new edition's length. A current subject title or ordinal is not historical evidence.
2. **Profile head change or retirement.** The private pin contains `provenance`, `releaseDigest`, `acceptingType`
   and `profileId`; it is vocabulary provenance, not a structure revision. Historical resolution uses that digest,
   not the active head. Recording checks incoming values against both the accepted and currently admitted
   descriptors; it never repins the session or revalidates all old values against the replacement profile.
   The same pair string is insufficient if bounds/precision now reject the new value.
3. **Original release absent or inconsistent.** The consumer contract requires explicit unavailable/incompatible
   handling, without falling back to current labels or `legacy-fixed-v1`. This is different from a current profile
   being absent while the old accepted release is still readable. A release rollback does not convert either case.
4. **Source unavailable or taken down.** An own session read is owner-scoped; source summary disclosure is a
   separate read. An omitted summary is not permission to obtain its title from another source. A dependency
   failure is not proof of deletion. Shared takedown rules withhold the least affected data, without automatic
   personal-fact purge or an invented completion. The precise native before/final/source checks stay with owners.
5. **Reread.** A new session has a new ID and independent values/history. Complete and abandon are owner lifecycle
   operations that need no new profile value; absence of a current profile does not by itself bar them. A new
   session or new record still requires current admission. No reread count reconstructs dates or missing sessions.

Sources: [profile consumer lifecycle and replay](../library-profile-consumers.md),
[pin resolver](../../services/kernel/src/library/profile.ts),
[native profile source](../../services/kernel/src/library/profile-source.ts),
[subject anchor](../../services/kernel/src/library/subject-anchor.ts) and
[FULL disclosure](../../services/kernel/src/library/views.ts). Profile activation and legacy pin migration are
already designed; neither is a structure conversion. Published logs remain separately and explicitly selected snapshots.

## Recommended smallest observable journey

These are recommendations for the existing owner contract and next meaningful whole progress slice, not new authority.

### Show the session's meaning before offering a change

On detail, show the original subject/version when currently disclosable, mode/unit, captured scalar total, exact
value or sparse count, paged raw IDs and paged intents. Resolve accepted vocabulary server-side from the private
pin. Keep a known historic label even if today's release renamed it. If historic vocabulary is unknown, show
the stored mode/unit with an explanation; if a required release cannot be resolved, retain the real unavailable
result. Do not disguise incompatible data as an empty progress set.

For session-local sparse IDs, say that the listed IDs are this session's records and that their relationship to
the current structure is unverified. For an opaque cursor, show its stored locator/position without a “resume in
this edition” promise. A changed-structure notice may name an actual change only when an authorized source
supplies that evidence. With today's `structure: none`, the truthful fallback is “current structure not verified,”
not a fabricated old-versus-new comparison. Do not cache hidden titles as historical meaning.

### Offer the same person only the actions their current capability admits

| Situation                                                                   | Observable choices and result                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old meaning resolves; current exact pair and proposed value remain admitted | Record manually in the existing session under the original meaning. Keep its pin, version, total and untouched history. This does not establish structural equivalence or a current-reader resume target.                                                          |
| Pair removed, profile retired or new value incompatible                     | Explain why a new record is refused; keep readable history. Offer authorized completion/abandonment of the active session as explicit lifecycle actions. Offer a new session only if current admission supplies a supported choice.                                |
| Another edition/version is wanted                                           | Explicitly select an accessible version for a new session; show the selected identity before submission. Keep the old session. The person may separately abandon it or leave it active; multiple active sessions already exist.                                    |
| Source temporarily unavailable                                              | Keep permitted own raw history, withhold unavailable summaries, and offer retry. Do not record against a guessed replacement source or translate a dependency error into “profile retired.” Lifecycle actions still follow their own actual authorization results. |
| Source taken down or permanently absent                                     | Respect field/record withholding and existing lifecycle rules. Do not fetch a mirror, erase progress automatically, or claim to distinguish permanent absence from temporary failure without owner evidence.                                                       |
| Reread the same version                                                     | Start a fresh admitted session with no copied completed IDs, amount, cursor or inferred dates. Earlier sessions retain their completion/abandonment and history.                                                                                                   |

Completion remains a conscious “I have finished this session” action; it never fills missing IDs or completes
the separate entry state. Do not present it as a repair for a broken source. Abandonment is not deletion or Undo.
If two commands are needed to abandon then start, show each result independently; a failed start must not imply
that the abandonment rolled back. Revision conflicts require rereading; exact authorized receipt replay keeps
its original response after a release change. Publication is a separate explicit choice; none of these steps
creates private/public feed activity, a public log, an entry state, a holding, or a use grant by inference.
Existing private activity timestamps may advance on successful commands under their current contract.

## Exact gaps versus existing delivery

| Interface or field                                                                   | Finding and recommended treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `progress_session.library_profile_pin` and `resolveLibraryProfilePin`                | Already source-present. Do not add a second profile store, a mutable current pin or a numeric profile revision. Preserve exact historic pins and receipts.                                                                                                                                                                                                                                                                                                                                                         |
| Owner detail accepted presentation / current record admission                        | Genuinely missing from the inspected HTTP `sessionSchema`/`sessionView`: Web accepts optional `unitLabel`, count forms, dimension and `inputRules`, but the route supplies none. Detail initially uses `offered = !unsupported` and learns retirement from a rejected mutation. Adopt a bounded server-resolved detail presentation/admission seam; do not infer write permission from a label or expose private pin fields. Response names/transport require owner agreement; no new endpoint is authorized here. |
| Web `ProgressStartInput.versionSubjectId`                                            | Absent from the Web type, validator, form and POST body; already supported by kernel creation and stored on the session. An explicit version choice is a consumer gap, not a missing version column. Current source proves readable subject resolution, not work/edition relationship validation or immutable content equivalence.                                                                                                                                                                                 |
| [Structure identity and revision](../../packages/definitions/src/library-profile.ts) | Genuinely absent: `LibraryProgressUnitDescriptor.structure` supports only `{kind: 'none'}`; sparse identity is only `session_local`. The session has no immutable content/structure revision address or accepted ordered-unit manifest. `versionSubjectId` is a subject reference, not that address. No unit-to-source resolver or cross-version map is supplied.                                                                                                                                                  |
| Cursor resolver                                                                      | Absent: parser validates bounded locator text and numeric position only. Do not install EPUB parsing/matching or a provider adapter to make the UI promise work.                                                                                                                                                                                                                                                                                                                                                   |
| Sparse storage and rereads                                                           | Already source-present: exact unit keys, maintained cardinality, separate session IDs and append-only intent rows. No range expansion, history migration, bulk conversion or derived completion is needed.                                                                                                                                                                                                                                                                                                         |

“Continue recording” and “resume reading a source” must remain distinct outcomes. The former can use the
existing manual session engine; the latter needs a source owner's version-bound location capability, if ever adopted.

### Compatibility and final authority constraints

Use existing owner account/scopes, gates, current authorization, revision CAS, request digest and receipt order.
Pins stay private and absent from BASIC/Continue, events and published snapshots. FULL current subject summaries
must not relabel history; current disclosure must cover original/source/version/terminal references as required
by their owners. No current head lookup enables a missing profile or an unsupported type, including People/Concepts.

The next whole slice must consume the native before/final/source/subject anchors and their actual failure results.
A display-time capability is advisory: reauthorize and validate at the write's authoritative acceptance point.
Neither this report nor a read-time observation proves that a released foreign anchor remains authorized at final
use. Any producer/final-authority gap must remain explicit in the owning contract; do not fill it with a private
profile cache, guessed source grant, matcher or autoactivation. Keep reads bounded to one session/page, its pinned
release and declared current source observations, never all history or an entire library to infer compatibility.

## Later examples worth adopting and proving

These are candidate journey examples for the existing owners, not new tests or assertions of passing acceptance:

- Start a sparse session on version A; record `{1,3,7}`. A source later reorders, removes `3` and adds `8`.
  History still returns exactly `{1,3,7}` and count three. Without a structure producer, show unverified mapping;
  never call the retained key a verified deleted chapter or render current units as checked.
- Record scalar `120` of captured total `300`, and separately cursor `chapter:one` / `12.25`. Another edition has
  `360` pages and a renamed chapter. Old values/totals remain exact; a new version session starts empty. Neither
  a proportional amount nor a corrected locator appears automatically.
- Activate a release removing the old pair, then roll back. Old history retains its accepted label/pin; rejected
  fresh records have no effects. Authorized exact replay remains unchanged. An unknown historic unit stays raw;
  a missing required accepted release remains unavailable, with no current-label or legacy fallback.
- Withdraw source visibility, then restore it; separately exercise dependency failure and takedown. Own permitted
  raw facts survive, summaries obey current disclosure, and other/anonymous viewers learn no private values or
  pins. Explicit completion/abandonment and a later admitted reread preserve separate session IDs and dates.

## Limitations and handoff

This closes the focused research question with an adoptable preservation-and-choice recommendation, not with
an invented structure engine. Unverified content identity, source-change detection, historical structure labels,
cross-edition matching and reader resume remain unproved or absent. No vendor internals were inferred from marketing.
Source statements above establish only the inspected paths and documented behavior, not an exhaustive absence proof.

The manager can adopt the display/admission and explicit version/new-session choices into the existing profile
consumer and progress contracts, then brief one complete UI/API/storage journey using their native acceptance.
No new parser, matcher, structure editor, import, profile, grant, achievement system or activation is authorized.
No discussion-topic authority moved. The only work outside the declared report path is the permitted reference
`INDEX.md` provenance addition for the two reused clones. No code workspace changed, so no workspace typecheck
applies. No acceptance command, worker-check, tests, native/database/browser/remote check or generator was run;
native/full-row/main completion remains unproved.

[bw-repo]: https://github.com/bookwyrm-social/bookwyrm/tree/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4
[bw-licence]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/LICENSE.md
[bw-book]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/book.py
[bw-progress]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/readthrough.py
[bw-reading]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/reading.py
[bw-editions]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/books/editions.py#L85-L129
[bw-guide]: https://docs.joinbookwyrm.com/shelves.html
[cfi]: https://idpf.org/epub/linking/cfi/
[epub]: https://www.w3.org/TR/2026/REC-epub-33-20260113/
[w3c-licence]: https://www.w3.org/copyright/software-license-2023/
[komga-repo]: https://github.com/gotson/komga/tree/023ec905c10a35bbb8e29095420d266cd3adad60
[komga-licence]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/LICENSE
[komga-book]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/model/Book.kt
[komga-progress]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/model/ReadProgress.kt
[komga-dao]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/infrastructure/jooq/main/ReadProgressDao.kt
[komga-lifecycle]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/service/BookLifecycle.kt
[komga-read]: https://komga.org/docs/guides/read-progress/
[komga-trash]: https://komga.org/docs/guides/trash/
