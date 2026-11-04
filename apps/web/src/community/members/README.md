# Realm member management

`/realms/:id/members` is a private management destination, linked from the existing Realm management region.
It takes the Realm anchor, never the containing Space ID. Navigation admission grants no enumeration or command
authority. The installed route uses `boundedRealmMemberPage`, an explicit unavailable adapter with no network calls.
An ordinary member receives no roster or commands from this interface.

Decision: management discovery uses the existing exact-Realm `realm.update` permission or current appearance
`canManage` observation, both owned by `realm:manage`; ban-list admission and Space-only grants do not qualify.
The management host supplies these observations without a new probe or a private query snapshot.

Decision: keep production unavailable until the installed roster has generated GET declarations and exposes current viewer/authority advice for selection; neither account ID nor `membership: 'member'` can stand in for that interval.

Decision: interval tokens are opaque within their exact Account selection; tokens need not be globally unique across
different Accounts.

## Producer boundary

The installed [native producer](../../../../../services/kernel/src/community/README.md#realm-member-page) mounts
`GET /v1/realms/:realmId/members` (`realm.members`, public operation exposure, private `realm:manage` admission), with
optional exact `accountId` inspection. Its installed schema caps pages at 20 rows, names at 4,096 UTF-16 units, cursors
at 4,096 characters and serialized responses at 600,000 UTF-8 bytes. It publishes add/ban/unban advice and explicitly
unavailable remove/role variants; it publishes no media grants. Its rows and selected observations now expose the producer-owned opaque `episode` binding; a leave/rejoin changes it. Shared generated declaration installation remains publisher-owned. A server source or a local factory does not establish an installed generated
consumer. The visit therefore retains its unavailable production adapter. These consumer types remain illustrative
composition types, not a proposed wire schema. `pageBound` must come from that installed producer when bound;
fixtures use 20 only to exercise bounded composition.
Cursor bytes pass through unchanged. Selected inspection never moves the page cursor. An empty page with `next`
retains More. A failed page retries the exact original address. Denial is distinct from empty or unavailable.

The visit indexes one admitted page and obtains one observation per deliberate selection. Selection captures the
exact account, producer-owned membership interval when selected from a row, and authority revision; an entered
Account ID never supplies an interval. A reordered or replaced page cannot substitute another account. Failed
selected lookup shows no fallback identity. Concealment or interval change removes the former page observation.
Returning restores keyboard focus to the still-current account button, otherwise the heading.

Realm, caller, session/CSRF epoch, locale, exposure or source replacement retires the old visit and all deferred
read/focus effects. The browser observes successful normalized session observations, including error/invalidation and
same-credential replacement, and both legacy and incarnation-keyed viewer exposure queries. Every away/back transition
retires the old visit synchronously, even when React batches it. Observer bookkeeping, another viewer's exposure and unrelated queries do not
retire a visit. Cache subscriptions last only while a visit or Panel observes them; no exposure or role read is added.
Effect replay keeps the original producer observation, including changes while its subscription is disconnected;
reconnecting cannot acquire a replacement lifetime and revive a retired interval.
All private visit data stays in component memory, outside query
cache, route loader data, metadata, storage and diagnostics. Native disclosure still owns all account presentation.
There is no avatar integration until admitted media grants and their caps are published.

Decision: accept producer-owned lifetime observations through the optional `observe` composition seam; invalidation
retires the entire connected visit and deferred selection/focus work without a refresh or a locally invented revision.
The producer must supply a permanently invalidated observation after any disclosure, account, Realm or interval change.
This seam does not publish native notifications or permit production binding before the exact interval is available.

## Actions and pending work

The default production source remains unavailable and makes no requests. An explicitly installed consumer source may
provide selected advice only with its current Account observation. The composition has one entered Account lookup,
uses the existing membership POST owner for selected add, and passes one selected identity through a narrow context
to the default `RealmBansPanel`; that Panel remains the ban/unban writer. No remove, role, approve or mute command is
added. Neither enumeration nor identity alone supplies action authority.

The add review names the exact Account and Realm. Its frozen intent keeps the Account, Realm, authority observation,
starting interval and idempotency key together; interval proof stays local and is not sent as a wire field. A definite
native non-application reports rejection. An uncertain result can be retried only by explicit activation with the
same intent and key. Accepted work stays pending until an explicit selected readback reports a current membership
interval; that readback updates the selection and never advances the roster cursor. Ban and unban continue through
their existing command owner, reauthorization, immutable command, uncertain retry and readback. Changed selection,
identity, advice or producer currentness retires the review before it can write.

## Cost

- Touches: one page request per explicit page operation, at most one selected request per deliberate selection,
  explicit retry or status check; no identity hydration, global scans, hidden refill, client sorting, accumulation or
  polling.
  The installed unavailable adapter makes zero native requests.
- Bound: one page, one O(N) index and one active selection. Its last ready observation may stay in component memory
  during an explicit same-address status read so accepted work remains pending after a failed read; it is never shown
  as a fallback identity. No guessed wire string, cursor or media caps; publication must provide them before
  production binding. Concealed rows carry no identity. The consumer rejects duplicate accounts,
  mismatched Realm/selection/currentness and rows beyond the supplied producer bound.
- Growth check: supplied 1/10/20-row tests pin finite consumer requests and replacement. Content retains native
  256/1024/4096 membership/history/partition growth. These fixtures cannot establish producer bounds or native cost.

## References and remaining visit

Read for this composition: the current Space page/management context, ban Panel/control/transport and lifetime,
membership action/lifetime owners; `legacy-final:apps/web/features/manage/members-state.ts`, `members-view.tsx` and
`members.stories.tsx`; the earlier app's `features/realms/realm-members.tsx`, `realm-permissions.ts` and
`realm-settings-workspace.tsx`; the research documents `content-realms-spaces-design.md`, `design-status-content.md`
and `page-needs-api-render-audit.md`, and the reference INDEX. The earlier apps inform exact-person recognition and
keyboard recovery; their roles, search, bulk updates, invitations and duration controls are not native contracts here.
No legacy code was ported.

Connected stories exercise ready, long/private names, sparse, denied, selected unavailable, pending membership,
revocation, and add rejection, uncertainty and accepted-pending through the existing membership command owner with
deterministic response fixtures. The remaining mounted native/page source acceptance and phone390/desktop1280 light/dark keyboard
review across all eight locales are integration-owned. Existing Storybook capture ownership remains unchanged.
Consumer fixtures and an unavailable production source do not establish native 256/1024/4096 growth or a production
roster binding.

## Native read transport

Decision: preserve the unavailable default until native viewer/authority projection is connected; the minimal
`native.ts` wire seam reads real mounted data without converting episode tokens into page authority or inventing viewer advice.
`request.ts` resolves the admitted browser session and checks its subject before calling the native GET; `transport.ts`
keeps this explicit read private and outside route loaders. The seam is source integration, not installed generated
typing or completion of the route journey. No membership or ban writer is introduced. Native `member` maps to
consumer `current` only once connected; `none` establishes absence of a current membership, never `pending` or workflow
completion. Preparation stays separate from a ready empty roster.

Cost: native read transport

- Touches: one GET per explicit request, with optional exact Account and opaque cursor; no hydration, refill, or scan.
  Session preparation uses the existing session owner. Producer authentication and nested native work remain charged
  to the mounted operation, not established by these receiver fixtures.
- Bound: at most twenty rows and one exact selected Account, 4,096-unit names/cursors and a 600,000-byte response
  validation ceiling. This validation occurs after native materialization and establishes no upstream physical bound.
  Closed actions preserve native reasons and admit only the mounted target and operands.
- Growth check: receiver tests fix one request independently of response states; native 256/1024/4096 work and the
  mounted route-to-command journey remain in the continuation and controller acceptance.

Additional sources read: `legacy-final:apps/web/features/manage/realm-team-recorded-page.tsx`, its actual members
route and `admin-api.ts`; `/home/edge/projects/rezics/rezics/apps/web/features/realms/realm-members.tsx`; reference
`INDEX.md`. No legacy implementation was ported.
