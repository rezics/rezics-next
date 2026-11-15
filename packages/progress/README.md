# `@rezics/progress`

Pure checks, drafts, and projections for one private Library progress session. Import `@rezics/progress`,
or `MAX_COMPLETED_UNITS` (`20_000`) and `MAX_PROGRESS_MEASURES` (`8`) from `@rezics/progress/limits`.
The root exports those ceilings too. A pure helper result does not establish API authorization or a
completed business operation. Policy stays with
[Library and Collections](../../docs/library-and-collections.md).

Commands own the account and the stored rows. A reread is a new session. The calling adapter checks
identity syntax and routing. No descriptor means the legacy unit set and the legacy percent cap. A
descriptor is trusted compiled profile data. `'syntax'` checks shape only. `package.json` exports `.`
(`src/index.ts`) and `./limits` (`src/limits.ts`). The package is private and `AGPL-3.0-only`.

`ProgressOutcome<T>` is `{ ok: true, value: T }` or `ProgressInvalid` (`{ ok: false, field: string }`).
`JournalPatchOutcome` and `JournalDraftOutcome` use the same `ok` split. `parseJournalDate`,
`parseJournalDateText`, and `parseJournalAssessmentText` return `null` on failure.
`acceptsProfileDecimal` returns a boolean. `exactProgressDecimalIssue` and `progressLocatorIssue` return
a `ProgressInputIssue` or `null`. The lexicographically smallest unexpected key is `field`. Checks use
the submitted characters, including spaces.

## Decimals and locators

`acceptsProfileDecimal(metadata: NumericProfileMetadata, value: unknown): boolean` accepts a string of
at most 19 characters matching `progressDecimalPattern`
(`/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/`). The match must be the whole input, so a trailing newline
fails. The fraction cannot exceed `metadata.precision` (6 when omitted). Present `minimum` and `maximum`
compare as 12-digit integers plus 6-digit fractions, in digit order. Unit names and labels are ignored.

`progressDecimalPlaces(step)` is the fractional length of `step`, or `0`. `ProgressDecimalRules` is
`{ min?, max?, step? }`. `exactProgressDecimalIssue(value, rules = {}, required = true)` returns the first
of `required` (empty required text), `syntax`, `precision` (any step other than `'any'` allows only as
many fractional digits as that step string), `min`, and `max`. The step is a precision, not a multiple.
`progressLocatorIssue` returns `'locator'` at UTF-16 length `0` or above 256. `ProgressInputIssue` is
`'required' | 'syntax' | 'min' | 'max' | 'precision' | 'locator'`. `NumericProfileMetadata` is
`{ minimum?, maximum?, precision? }`. `ProgressUnitRules` adds
`totalPolicy?: 'optional' | 'required' | 'forbidden'`. `ProgressInputRules` is `{ min?, max?, step, total }`.

## Sessions, records, and transitions

`ProgressMode` is `'scalar_amount' | 'cursor_position' | 'completed_units'`. `ProgressState` is
`'active' | 'completed' | 'abandoned' | 'retired'`. `ProgressAction` is `'complete' | 'abandon'`.
`ProgressUnit` is `string`. `ProgressRecordContext` is `{ unit, state }`.

`parseSessionCreate(input, descriptor?: ProgressUnitRules | 'syntax')` reads `subjectId`,
`versionSubjectId`, `mode`, `unit`, `total`, and `additionalMeasures`. A subject id has length 1 to 128;
a missing or `null` version id becomes `null`. Legacy units are `page`, `chapter`, `episode`, `volume`,
`minute`, and `percent`. A descriptor requires `/^[a-z][a-z0-9_.-]{0,63}$/` on the whole string. `total`
is kept only for `scalar_amount` and is `null` when unknown. Legacy `percent` rejects a value above 100;
`100` and an all-zero fraction such as `100.0` remain. A rules descriptor can require or forbid that total.

`additionalMeasures` belongs to `scalar_amount`, holds 1 to 7 entries, and returns in code-unit order.
Units are unique, including the primary, so the session stays within `MAX_PROGRESS_MEASURES`. Those
entries use `'syntax'` when a descriptor was supplied, and the legacy rules when it was absent.
`parseProgressMeasureCreate(input, descriptor?)` applies the descriptor it receives.
`ProgressMeasureCreate` and `ProgressMeasureDraft` are `{ unit, total }`.

`parseRecord(mode, input, context, descriptor?)` requires `state: 'active'` and a context unit under the
same unit rule. Scalar input is `{ amount }`. Cursor input is `{ locator, position }`: the locator has
1 to 256 UTF-16 code units, and position uses the decimal rules with the percent cap off. Completed-unit
input is `{ add }`, `{ remove }`, or both, with at least one id kept in submitted order. An id has length
1 to 128 from `0-9A-Za-z` and `-.:_~`. Each list, and both lists together, holds at most 100 ids.
Duplicates, overlap, a non-array, or an empty pair fail. The empty pair is field `add`. The combined cap
is `remove` when that list is present, otherwise `add`. A non-object body is `session`, `measure`, or
`record`.

`transition('active', 'complete')` yields `completed`; `transition('active', 'abandon')` yields
`abandoned`. `correctOccurrence(state, 'retire')` yields `retired` from `active`, `completed`, or
`abandoned`. `correctOccurrence(state, 'reopen')` yields `active` from `completed` or `abandoned`.
Retired input fails as `state`. Recorded amounts, positions, and unit counts stay records.

## Intent and projection

`ProgressIntent` is a lifecycle correction (`reopen` or `retire`, `previousState` except `retired`,
`previousCompletedAt: string | null`), a clear, a measure clear, a scalar amount, a cursor, or id lists.
`changeIntent(record, measureId?)` returns the amount, cursor, or id-list form of a validated record. A
scalar `measureId` is copied through. Id lists are copied, sorted by code unit, and remain the given ids.

`nextUnitCount(current, added, removed)` returns `current - removed + added` for non-negative safe
integers when `removed` does not exceed `current` and the result does not exceed `MAX_COMPLETED_UNITS`.
`added` counts submitted ids that were new. `removed` counts submitted ids that already existed. Failure
fields are `current`, `added`, `removed`, and `completedUnitCount`.

`ProgressValues` holds `mode`, `unit`, `amount`, `locator`, `position`, `completedUnitCount`, `state`,
`completedAt`, and optional `measures`. `ProgressScalarMeasure` is `{ unit, total, amount }`.
`ProgressValueUpdate` is that editable subset. Identity, revision, and the profile pin stay with the
occurrence. `isProgressClear` is true when `clear === true`, every own key is `clear` or `measureId`, and
a present `measureId` is a string. An empty value, a zero, or a missing `clear` fails.

`clearedProgressValues(current, measureId?)` projects a clear after native admission. A measure clear
requires `scalar_amount` and the primary or a sibling unit, and nulls that amount. A whole clear nulls
amount, locator, position, and every sibling amount, and sets `completedUnitCount` to `0`. `state` and
`completedAt` stay. The sparse-set adapter removes membership rows. `recordedProgressValues` requires
`active`. A scalar writes the primary amount when `measureId` is omitted or equals `unit`, and writes one
sibling when `measureId` names it. A cursor writes `locator` and `position` and rejects `measureId` with
field `mode`. A completed-units record yields `{ ok: false, field: 'completedUnitCount' }`. Membership
stays a native fact.

## Journal

`ProgressSessionJournal` is `{ sessionId, revision, startDate, finishDate, reflection, assessment }`.
Its revision is independent of progress state and measures. A date is `{ year, month?, day? }` and keeps
the supplied precision. `parseJournalDate` allows only those keys: integer `year` 1 to 9999, `month` 1 to
12, and `day` only with `month` on a real Gregorian day, including leap days. `assessment` is
`{ meaningRevision: 1, units: number | null }`. `OCCURRENCE_ASSESSMENT_MEANING_REVISION` is `1`. Patch
units are integers 0 through 20. `ProgressSessionJournalWrite` is `{ sessionId, revision, changed }`.
Private field values are read on the session route; issuing the receipt stays with that route.

`parseProgressSessionJournalPatch` requires a safe-integer `revision` from 0 through 2147483646. Omitted
fields stay omitted. `null` clears a date, `reflection`, or `assessment`. Reflection must be well-formed,
contain no U+0000, and stay within `MAX_JOURNAL_REFLECTION_CHARACTERS` (2000 code points) and
`MAX_JOURNAL_REFLECTION_BYTES` (4096 UTF-8 bytes). A non-object body fails as `journal`.

`JOURNAL_FIELDS` is `startDate`, `finishDate`, `reflection`, `assessment`. A `JournalFieldDraft` is
`{ kind: 'untouched' }`, `{ kind: 'set', text }`, or `{ kind: 'clear' }`. `emptyJournalDraft` is all
untouched. `formatJournalDate` prints `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or `''`. `parseJournalDateText`
returns `null` for empty or invalid text. `formatJournalAssessment` prints an even half-point count as
its integer score and an odd count as `n.5`. `parseJournalAssessmentText` accepts `0`–`9` with optional
`.0` or `.5`, plus `10` and `10.0` (`'7.5'` is 15, `'10'` is 20).

`journalDraftText` returns set text, `''` for a clear, or the current field as text.
`buildJournalDraftPatch(revision, draft)` turns chosen fields into a patch. Clear becomes `null`. Dates
and scores must parse, and reflection must pass the patch limits. `changedFields` follows `JOURNAL_FIELDS`.
Failure names that journal field, or `'revision'`. `applyJournalPatch` overlays fields the patch owns and
keeps `sessionId`, `revision`, and `assessment.meaningRevision`. Compare-and-swap, receipts, and admission
stay with the native writer. `sameJournalDate` compares one date pair. `sameJournalValues` compares the
dates, reflection, meaning revision, and units. `reviewJournalDraft` returns kind, `before`, and `after`
for that read. Absent stored values and a clear use `null`; set `after` is the raw draft text. Callers
retire the review with the originating reader.

## Examples

```ts
import { parseRecord, parseSessionCreate, transition } from '@rezics/progress';

parseSessionCreate({ subjectId: 'subject-1', mode: 'scalar_amount', unit: 'page', total: '240' });
// { ok: true, value: { subjectId: 'subject-1', versionSubjectId: null,
//   mode: 'scalar_amount', unit: 'page', total: '240' } }

parseRecord('scalar_amount', { amount: '12' }, { unit: 'page', state: 'active' });
// { ok: true, value: { amount: '12' } }

parseRecord('scalar_amount', { amount: '12' }, { unit: 'page', state: 'completed' });
// { ok: false, field: 'state' }

transition('active', 'complete'); // { ok: true, value: 'completed' }
```

```ts
import { buildJournalDraftPatch, emptyJournalDraft } from '@rezics/progress';

buildJournalDraftPatch(3, {
  ...emptyJournalDraft(),
  finishDate: { kind: 'set', text: '2026-11-15' },
  assessment: { kind: 'set', text: '7.5' },
});
// { ok: true, patch: { revision: 3, finishDate: { year: 2026, month: 11, day: 15 },
//   assessment: { units: 15 } }, changedFields: ['finishDate', 'assessment'] }
```
