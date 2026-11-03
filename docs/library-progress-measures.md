# Independent progress measures

This document owns scalar progress values recorded together in one private Library session. A session is one
consumption occurrence; it may retain multiple independent scalar measures without translating one into another.

Decision: Keep the existing session's `mode`, `unit`, and `total` as its primary measure; admit up to seven additional
profile-approved scalar units in that session, and guard every measure write with the existing session revision.

## Admission and meaning

The existing Semantic library profile is the only source of measure IDs, labels, bounds, precision, total policy and
activation. The primary and each additional unit must be admitted as `scalar_amount` by the subject's active profile,
with native structure `none` and identity `none`. The accepted session pin fixes the profile release and accepting
type for every measure in the session. A measure ID is that profile's exact unit ID; there is no local unit catalogue,
conversion ratio or new global vocabulary.

At most eight measures, including the primary unit, may be recorded in one session. Additional IDs must be distinct
from each other and from the primary unit. The server sorts additional IDs by code unit for stable receipts and reads;
the primary measure is always first in the returned array. Unsupported units, structures or mode combinations return
`422 unsupported_library_profile`.

Stored `amount` and `total` values remain decimal strings. `amount: null` means no value has been recorded; `amount: "0"`
is the recorded value zero. `total: null` means no total is known. Bounds and precision apply separately to each
measure using its accepted and current descriptors. Updating or clearing one measure does not change any other
measure. A dimension difference does not trigger conversion.

The measure array is an owner-only projection of the existing session row. The primary value stays in the existing
session columns; additional values are stored with that row and share its owner, profile pin, history, revision and
terminal deletion. No separate measure store or cleanup phase is introduced.

## Native API contract

Existing single-measure calls keep their request and response shape. The `measures` result property is omitted for
single-measure sessions. For a multi-measure session, authenticated owner methods are:

### Create

`POST /v1/progressSessions` keeps the existing fields and accepts `additionalMeasures` only for `mode: "scalar_amount"`:

```json
{
  "subjectId": "...",
  "mode": "scalar_amount",
  "unit": "chapter",
  "total": "24",
  "additionalMeasures": [{ "unit": "volume", "total": "12" }]
}
```

Each measure starts with an absent amount (`null`). The `201` response contains the existing session fields and:

```json
"measures": [
  { "unit": "chapter", "amount": null, "total": "24" },
  { "unit": "volume", "amount": null, "total": "12" }
]
```

The primary unit is the existing `unit`; `additionalMeasures` contains only further scalar units. Create continues to
require the existing `Idempotency-Key`. Replaying its original key and normalized command returns the original
session response without another session or activity effect.

### Read

`GET /v1/progressSessions/:sessionId` returns the same owner-only session projection, including all measure values.
Foreign and anonymous reads retain the existing concealed `404` response. `?presentation=FULL` includes the existing
top-level primary presentation and a `presentation` on each returned measure. Each presentation preserves the existing
`known`, `unknown` and `unavailable` meanings and says whether current recording is `supported`, `unsupported` or
`unavailable`. It uses the exact accepting release for labels and the current active profile only for admission; it
never rewrites or hides stored values because a profile changed.

### Record and correct

`POST /v1/progressSessions/:sessionId:record` keeps the existing revision and idempotency contract. Include
`measureId` to address one scalar unit:

```json
{ "revision": 3, "measureId": "chapter", "amount": "10.5" }
```

The `200` response is the full session projection with the addressed value changed, all other measure values retained,
and the session revision advanced once. A stale revision returns `409 conflict` with no effect. An unknown measure ID
returns `400 invalid_request`; an unavailable or incompatible profile returns `422 unsupported_library_profile`.
Replaying the same command with its original `Idempotency-Key` returns the same response and appends no second history
entry. Reusing the key for a different command returns the existing idempotency conflict.

Targeted clear is `{ "revision": 3, "measureId": "volume", "clear": true }`. It sets only that measure's amount to
`null`, retains its total and every other value, advances the session revision and records one `{measureId, clear:true}`
history intent. The existing `{ "revision": 3, "clear": true }` form still clears the whole session's recorded values;
it retains totals, the session, pin, lifecycle state and dates. Both forms require the same revision and idempotency key.

The typed client exposes `ProgressSessionCreate.additionalMeasures`, optional `ProgressSession.measures`, and
`ProgressScalarMeasure { unit, amount, total }`; values and errors match this HTTP contract.

## Scope

This slice supports profile-approved scalar units, including chapter and volume when both are admitted by the same
profile. It does not add cursor or sparse-unit measures, canonical episode membership, historical user dates, repeat
totals, a new entry state, provider-specific progress storage, or a parallel import engine. Consumers may preserve
separate source values only when their active Library profile admits both units.

The focused native journey is in `services/kernel/test/library/progress-http.test.ts`. Broader native and browser
acceptance remains controller-owned.
