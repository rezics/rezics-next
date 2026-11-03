# Realm member management

`/realms/:id/members` is a private management destination, linked from the existing Realm management region.
It takes the Realm anchor, never the containing Space ID. Navigation admission grants no enumeration or command
authority. The installed route uses `boundedRealmMemberPage`, an explicit unavailable adapter with no network calls.
An ordinary member receives no roster or commands from this interface.

Decision: keep production unavailable until Content publishes its bounded roster and exact selected-account reader;
implement the single-page inspection composition against a local interface without inventing native DTOs or actions.

## Producer boundary

The retained generated Community client has `members.post` and `members.me.get`, but no roster GET or exact selected
account observation. The supplied Content backlog path was absent at the start of this implementation. Content must
publish the actual route, operation/exposure, generated client, authorized examples, response caps, membership
currentness and supported action variants. These consumer types are illustrative composition types, not a proposed
wire schema. `pageBound` must come from that installed producer; fixtures use 20 only to exercise bounded composition.
Cursor bytes pass through unchanged. Selected inspection never moves the page cursor. An empty page with `next`
retains More. A failed page retries the exact original address. Denial is distinct from empty or unavailable.

The visit indexes one admitted page and obtains one observation per deliberate selection. Selection captures the
exact account, membership episode and authority revision; a reordered or replaced page cannot substitute another
account. Failed selected lookup shows no fallback identity. Concealment or episode change removes the former page
observation. Returning restores keyboard focus to the still-current account button, otherwise the heading.

Realm, caller, session/CSRF epoch, locale, exposure or source replacement retires the old visit and all deferred
read/focus effects. The browser reuses the ban owner's session-cache observer and observes existing exposure-cache
replacement without fetching exposure or roles. All private visit data stays in component memory, outside query
cache, route loader data, metadata, storage and diagnostics. Native disclosure still owns all account presentation.
There is no avatar integration until admitted media grants and their caps are published.

## Actions and pending work

This part supports inspection only. It admits no add, remove, role, approve, mute, ban or unban command. Successful
enumeration or readable identity supplies no action authority. Pending membership text never certifies participation.
No selection can trigger a write, readback, hidden refresh or polling operation.

The continuation binds current selected action advice after producer publication and integrates the existing default
`RealmBansPanel` through a narrow selected-account context. That Panel remains the ban writer. Existing membership
and ban owners retain transport, reauthorization, immutable intent/key, uncertain retry and truthful readback.
Accepted membership work must remain pending until native completion/readback; failed readback remains uncertainty.
New selection or changed advice must never replay an earlier command. No new command engine belongs here.

## Cost

- Touches: one page request per explicit page operation, at most one selected request per deliberate selection or
  selected retry; no identity hydration, global scans, hidden refill, client sorting, accumulation or polling.
  The installed unavailable adapter makes zero native requests.
- Bound: one page, one O(N) index and one selection. No guessed wire string, cursor or media caps; publication must
  provide them before production binding. Concealed rows carry no identity. The consumer rejects duplicate accounts,
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

Connected illustrative stories exercise ready, long/private names, sparse, denied, selected unavailable, pending
membership and revoked while open. Rejected/unknown command stories, native mounted action/readback tests and the
phone390/desktop1280 light/dark keyboard review across all eight locales remain in the continuation. Existing
Storybook capture ownership remains unchanged. Unavailable production and fixture inspection alone do not complete
the management outcome.
