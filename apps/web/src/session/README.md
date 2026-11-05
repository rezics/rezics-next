# Browser session observation

Web owns `browserObservation(client)`: one mounted cache subscription and one monotonically retiring reader
observation per QueryClient. `useSession`, platform viewer exposure, catalogue candidates/editors and private
History/Library/Ratings readers subscribe through that observation. The cache remains the session source; this
observer does not authenticate a request or persist a private payload.

A successful session incarnation binds the actual query object, response identity, successful-update count,
update time, account and CSRF token. Equal successful data is still a replacement. Removal/recreation, A/B/A,
same-account session replacement and the last subscriber leaving retire the old observation permanently. Exposure
reads have observation-specific keys; late responses cannot admit a new visit. Resource viewerActions remain
independent of platform exposure and neither is supplied by session data.

Decision: share observation and retirement, while retaining separate read admission, operation admission, address
leases and feature retained-state adapters. `reader/workspace-admission` composes platform decisions per operation;
`reader/current-origin` composes mounted address and successful response provenance. Read admission requires no
mutation credential. Dispatch reads the current credential independently, and every server request still prepares
and authenticates its own session under Accounts' contract.

Catalogue's candidate boundary keys visits by address and reader observation. Editor holders retain private drafts
under their existing current-reading adapter, while transports and callbacks belong only to the admitted reading.
History's operation episodes retain native intent during healthy credential rotation; dispatch versions retire
callbacks immediately. Private read keys include dispatch and observation identity, so a retained draft never
reuses its prior private reading after session replacement. Refusal, account replacement and replaced response identity keep their stronger retirement
rules. Ratings owns its operation/context descriptor and original vote-pair identity; its currently required
personal_library exposure policy is explicit and does not imply Library membership or resource action grants.

An uncertain command retains the original operands, credential, method and key under its feature owner. A browser
lease only refuses stale dispatch/completion; it never reconstructs, upgrades or automatically retries that intent.
Native authorization, disclosure and prepared authenticated requests retain their existing owners.

Decision: cache observers reconcile authority synchronously, while React notifications coalesce through the shared
browser observer's microtask publication. Snapshot reads never publish or evict another query. Captured guards
inspect current authority immediately, including every intervening cache transition; publication reads the latest
snapshot and cannot restore an old incarnation. Retired exposure keys become inadmissible immediately and are
physically removed during publication, outside render. Raw cache subscriptions remain synchronous for response
epochs and command retirement. React-facing session, exposure, workspace admission, response provenance and Inbox
subscriptions publish after the current stack and ignore released listeners. Inbox retains its account viewer epoch
and independent credential fencing for original uncertain commands; phone and desktop share its existing count query.
Subject community/reaction revisions and personal response epochs also retire in-stack; their existing adapters
publish React notifications through this same observer without changing specialist admission or command custody.

Decision: outage recovery retains only a bounded, query-free local return path in a short-lived HttpOnly login cookie; callback credentials and private query state are never replayed.

## Public module entry

`session/index.ts` is the public browser adapter entry for observation and read/operation/address leases.
`session/reader.ts` exposes workspace admission and current-response/address composition without eagerly loading
those React/Query adapters for observation-only consumers. `reader/` contains its existing implementations;
these are Web runtime adapters, not Library infrastructure. Lease descriptors in `reader/lease.ts` have no
runtime imports. Authentication and request preparation retain their server-only entries.

Subject personal preferences and ratings subscribe to the shared observation only while mounted. Their local
registry owns response epochs and rating write arbitration, and releases its listener and retained scopes when
its last page observer leaves. Session incarnation comparison and session cache observation belong exclusively
to `browserObservation`. Equal successful replacement retires a personal query even when its account and token
are unchanged. Ratings inventory, Library naming adapters and catalogue readers use this public entry.
