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
Decision: native Inbox notices may nest thread, post and decision ids under `target`; the received host coverage
flattens those onto the notice so current-session identity assertions keep matching. Performance retains the Inbox
writer.
Subject community/reaction revisions and personal response epochs also retire in-stack; their existing adapters
publish React notifications through this same observer without changing specialist admission or command custody.

Decision: outage recovery retains only a bounded, query-free local return path in a short-lived HttpOnly login cookie; callback credentials and private query state are never replayed. An indeterminate private route offers explicit session retry and safe sign-in with that same bounded path. Neither action admits a private loader until a current signed-in observation succeeds.

## Public module entry

`session/index.ts` is the public browser adapter entry for observation and read/operation/address leases.
It also exports the installed `sessionQuery`, `useSession`, `sessionCsrfToken` and `AnonymousSessionContext` for
consumer-owned application composition. These are the original producer bindings, without a second fetch, cache
or provider. Settings and Inbox bind them through their own shell ports rather than importing `query.ts`.
`session/reading-policy.ts` is a pure entry for the existing public/personal query defaults, credential-mode keys and
platform-closed error/problem recognition. It loads no React observer, query cache or session fetch. Native and
browser readers share the original error class, including its serialized route-boundary recognition.
Public catalogue inspect reads the prepared cache through `cachedBrowserSession` and does not start a session fetch.
`session/reader.ts` exposes operation/workspace admission and current-response/address composition without eagerly loading
those React/Query adapters for observation-only consumers. `reader/` contains its existing implementations;
these are Web runtime adapters, not Library infrastructure. Credential-mode vocabulary lives in the pure `reader/lifetime/contract.ts` entry. Authentication and request preparation retain their server-only entries.
`SessionRecoveryPage` is the public indeterminate-session recovery prompt: callers pass the visit pathname and locale;
the session owner derives the safe sign-in href and the shell still renders the unavailable page. The leaf does not
read the router.

Decision: Copies supplies its locale Copies pathname to `SessionRecoveryPage` from this public entry rather than
importing private session or shell recovery files.

Subject personal preferences and ratings subscribe to the shared observation only while mounted. Their local
registry owns response epochs and rating write arbitration, and releases its listener and retained scopes when
its last page observer leaves. Session incarnation comparison and session cache observation belong exclusively
to `browserObservation`. Equal successful replacement retires a personal query even when its account and token
are unchanged. Ratings inventory, Library naming adapters and catalogue readers use this public entry.

Decision: public catalogue inspect and credit inspection read the prepared session cache through
`cachedBrowserSession`, which never starts a session fetch. An absent cache is unknown, a replaced successful entry
is the next read, and malformed or signed-out data never admits a subject. `tests/session-browser-cache.test.ts`
pins those states; the credit-inspection test covers the same cache through the mounted page.

Decision: security and credential effects stay on the served Auth security page, entered through Web’s existing
account menu. The personal driver follows that link and the native step-up return; it does not invent a Web security
route. Media acceptance uses the same browser cookies and CSRF token as production BFF requests.

Decision: the account-entry walk is `apps/auth/tests/sign-in-walk.test.ts`, run on a walk stack with
`REZICS_SIGN_IN_WALK=1 bun services/auth/scripts/dev-stack.ts walk -- bun test apps/auth/tests/sign-in-walk.test.ts`.
The journey stays unaccepted until a real walk passes.

Decision: delegated agent and principal media acceptance waits for Accounts' native delegated-client and assignment
fixture binding. The operator session is never used as a delegated proof; Alice, Bob, anonymous, revoked and suspended
cases bind the personal driver now.

## Supported reader lifetime

Decision: Threads and moderation reporter history/status consume the session-owned
[`reader/lifetime/index.ts`](../reader/lifetime/index.ts) browser capability. Its implementation owns the existing
session cache observation, credential lookup, leases, cache-only session source, activity retirement and optional
address/locale visits. The existing root session hook and QueryClient install its shared cache observation once.
Default navigation adapts the existing application Router; isolated mounts need neither a Router nor another provider.
Decision: the installed root shell supplies `ReaderNavigationContext` once, binding its existing Router through
`useReaderNavigationHost` from the public session entry. The capability has only `ReaderNavigation.address` and
`subscribe` from `reader/lifetime/contract.ts`; its mounted readers share one departure subscription, released when
the last reader leaves. An idle host reads the current Router address before a new reader subscribes. There is no
generic session-provider dependency, added session value, cache, fetch or authentication. Performance/session train
receiving resolves overlapping host edits. `tests/thread-reader-boundary.test.tsx` covers hosted and fallback Router
departure before replacement render, irreversible return visits and isolated QueryClient mounts.
The old observation, browser-state, lease and credential files remain compatibility entries for other owners.

The leaf adapter has no Web application or feature dependency. Cache-only Threads consumers no longer load the
fetching session query, server request preparation or exposure code through their session key. Credential-mode and local-return
vocabulary have a separate pure entry so native read and revision-return contracts do not evaluate browser adapters.
This extraction removes those behaviour edges rather than allowing private application imports in the manifest.

Session replacement, including equal successful responses and A/B/A, retires reader identity synchronously. The
cache-only session source releases its shared subscription when its last consumer leaves. Slow-mode callers abort
in the retirement stack; late continuations still check their original caller. Address/locale visits are irreversible
and host navigation observes departure before React replaces a page. Feature owners retain native response epochs,
exposure admission, exact uncertain command operands and focus ownership. No browser deadline grants native authority.
