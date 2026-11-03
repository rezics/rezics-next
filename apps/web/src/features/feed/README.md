# Feed results

`FeedResults<T>` is the shared ordered list, availability, empty-state and recovery region. It renders one named
`section` and an `ol` or `ul` of `ContentItem` rows. It does not add a page landmark. The caller keeps its page
heading and selects `emptyHeadingLevel` (default 2) for the explained recovery frame.

The caller projects its existing owner result to `FeedResultsResult<T>`:

- `ready` carries the owner's readonly ordered `items`, `hasNext`, and explicit `availability`. Availability can
  include named `sources` using `ready`, `preparing`, `unavailable`, or `not_requested`. Owners without source lanes
  still state `complete`, `partial`, or `unavailable` explicitly.
- `loading` and each existing failure state keep their discriminator and optional owner code. Localized loading,
  failure, partial, empty, sparse, retry, and restart text comes from `messages`.
- `getItemKey` uses the owner's occurrence or entity identity. `itemPresentation` returns the existing
  `ContentItemProps` except `headingLevel`, which belongs to this region. Rows stay in the supplied order; the
  renderer does not fetch, merge, sort, filter, deduplicate, accumulate, or interpret them.

The owner keeps `busy`, retry/restart callbacks, and the actual Next control. `nextControl` is an existing button,
Router `Link`, or anchor, so its original cursor, scope, sort, disabled state, and browser navigation behaviour stay
with the owner. `emptyActions` is rendered only for a ready page with no returned items. A selector may set
`suppressResultMessage` only when it explains the current blocked result; ready rows, partial availability, and
unrelated failures remain visible.

## Empty feed and recovery

`FeedEmptyState` composes the optional shared `@rezics/ui/empty-state` frame with a decorative state icon,
semantic heading, concise explanation and separate recovery controls. Existing callers can keep their flat
`messages`; `messages.explanations` adds localized titles and descriptions without changing item/action ports.
The explanation alone is live, so controls are not repeatedly announced. Ordinary empty, sparse, partial,
loading, auth and closed states use status; a failed request, denied access, expired cursor, timeout or fully
unavailable result uses alert. No frame moves focus. Home retains its current-visit explicit Next focus owner;
background refresh never moves focus.

- A complete terminal empty result explains discovery, Following, an admitted filter, or the end of a continued
  window. Only the last case offers Start again. A sparse page offers its original cursor-bound Next control
  and never claims that the entire feed is empty.
- Preparing or unavailable sources take precedence over empty/sparse wording. A wholly unavailable result is
  explained as unreadable, not empty. With actual rows, only the source explanation is announced beneath the
  unchanged list; the rows, item actions, Next control and explicit retry remain intact.
- While a complete empty result is refreshing, loading replaces empty wording. Existing rows remain visible
  during refresh. Caller `emptyActions` survive sparse and partial pages and appear only without rows.
- Auth uses the owner's localized sign-in link. Closed and denied results keep their gates without retry.
  Cursor failure keeps Start again; other retryable failures keep the original callback. An owner's
  `failureActions` slot can supply its existing gate. Private error codes and source payloads are never copy.

Decision: filtered empty recovery opens the existing filter controls. The filter surface and persistent summary
offer independent removal and clear-all through the same URL/history/reader retirement owner.
Home Search and sign-in destinations remain localized. No new Follow destination is invented: Following
can navigate through its existing Discover control. Source availability remains native authority.

`feedAvailability` makes one O(S) pass over the fixed supplied statuses; rendering remains O(N). No state
mount, transition, refresh explanation or recovery link introduces a read, source probe or automatic refill.
An explicit retry invokes the original bounded owner operation once. Home consumers retain their installed
request keys, cancellation, source/session retirement and unknown-write semantics.

Board326 can optionally import `EmptyState` and pass its own heading, explanation and controls. Its board
page-empty/end/pin meanings and existing continuation remain with that owner. Library, Search, Inbox and
moderator compositions remain independent.

`14-feed-empty-recovery` stories are visibly prepared presentation scenarios, not native acceptance. They
cover complete discovery/Following/filter/end, sparse continuation, partial rows and no rows, initial loading,
auth/closed/denied, cursor/deadline/request and unavailability at 390 and 1280, light/dark, long text and keyboard.
The focused tests cover all fixed source combinations with 0/10/20 rows, explicit callbacks, localized gates,
source explanation, retained row actions and focus during refresh. Existing Home lifetime tests retain
ownership of native request and session retirement.

Home's native `FeedItem` projection is `homeFeedItemPresentation(item, locale)`, typed from the generated Kernel
client. It retains the supplied title, canonical destination, cover/avatar, language, preview, source and occurrence
attributes, Continue progress, and separate resume link. Discovery Collections use the Commerce owner identity and
open `/collections/{id}`; reviews keep their Content thread identity and admitted reviewed-Subject context; Spaces
keep the current address and show a supplied Realm title only as carrier text. Collection curator and cover data,
and review ratings, stay absent until their bounded public owner summaries supply them. The adapter performs no
reads, does not rank or apply public/private predicates, and omits missing descriptive fields. Following
Collections and Content thread/post summaries keep their existing native identities and actions.

An embedded owner list can use the same body without claiming a native mixed-feed branch:

```tsx
<FeedResults<MyRealm>
  regionLabel={realmsHeading}
  itemHeadingLevel={2}
  listAs="ul"
  result={{ state: 'ready', items: page.realms, hasNext: page.next !== null, availability: { state: 'complete' } }}
  messages={messages}
  getItemKey={(realm) => realm.realmId}
  itemPresentation={(realm) => ({ title: realm.name, href: realmHref(realm.realmId) })}
  nextControl={
    page.next ? (
      <Link to="/realms" search={{ cursor: page.next }}>
        More Realms
      </Link>
    ) : undefined
  }
/>
```

Board and Realm public-discovery summaries absent from the installed native feed remain owner dependencies. Add a
native branch only after the source schema, disclosure, ordering, and generated-client receiving are delivered.

## Card actions

`FeedActionBar` from `action-bar.tsx` is the shared port for post, discussion, review and reply cards. The installed
Home renderer supplies it through `HomeFeedActions` in the actual `FeedResults.itemPresentation.actions` slot.
The original Continue link remains inside that slot. The action bar makes no mount reads, does not reorder rows,
and does not extend the native feed summary with assumed fields. Installed Realm/Space-scoped Home results use
the same adapter; unavailable Realm/Space and board carriers retain their owner state.

Pass the admitted localized `href`, `title`, `signedIn` and, when actually supplied, `reaction` containing the native
`target`, complete count map and current viewer slot. A count map omits zero kinds; it is not an unknown projection.
The score is upvote minus downvote from that map. Without a supplied map the pill shows an unavailable dash and
cannot write; it never reports zero or reads each row to manufacture a baseline. Subjects retain their installed
non-vote reaction kinds. A `plain` reply pill omits its filled background without reducing its phone targets.
`reaction.reactionOrigin` and `origin` bind commands and browser feedback to the owner's current source visit.
Every compact reaction control exposes each exact admitted operand in its accessible name, including both vote inputs
and the signed score. When a compact count differs from its exact locale form, retain the compact label in the
accessible name and append the exact operand in parentheses. Do not pass a fabricated current predicate to retain an
old private snapshot.

`VoteControl` delegates to `ThreadReactions` and the shared `Reactions` queue. It does not implement another vote
engine. Fresh feed commands reconcile through the existing single-target point read; `settleWithRead: false` lets
an existing detail owner retain its existing refresh callback. Unknown writes retain only their immutable current
visit command and explicit retry. A refused change restores the last projection and announces the native failure.
No command runs on mount or on a session observation. Account/token replacement and away/back retire old callers.

`reply` accepts an existing reply-intent callback or an admitted link; missing reply destinations remain unavailable.
An optional safe native `replyCount` is shown compactly and named exactly in the action's accessible label. Zero remains
visible as zero; absence or an unsafe value remains unavailable. The count does not replace or wrap the reply link.
`library` accepts the existing Library control or its owner destination. `overflow` accepts the installed author/report
menu so detail hosts keep edit, erasure and report ownership. Reporting is never a visible action button. Without a
delivered command/configuration the default menu labels report, mute and hide as unavailable. It never hides a row
or claims success locally. Signed-out actions navigate to localized sign-in with the admitted destination.

Decision: Work cards open their existing Subject Library slot (`?slot=collections`) for Add to Library; the slot keeps
its existing private reads, admission and mutation commands, and the feed introduces no private per-row hydration.
Share uses the native browser sheet when installed, then the clipboard when unsupported or refused. Cancellation
does not copy. Only a successful clipboard promise announces success. A blocked clipboard exposes the admitted URL
for manual copying and a Close action returning focus. Replacement visits retire pending share/copy feedback.

### Producer and board handoff

Decision: phone Share and vote-presentation reaction pickers use compact labeled icons; desktop Share retains its text,
and a copied link replaces the Share glyph with a check while keeping the control's accessible name and recovery flow.

The installed Kernel source emits optional `reactionTarget`, `reactions` and `viewerReaction` on eligible Content
thread/post summaries and optional `reactionsAsOf` on the page. The current generated Web client has not published
those fields: its `FeedContentSummary` still has only author and excerpt, and its page type lacks `reactionsAsOf`.
Until normal client generation publishes them, Home keeps reactions unavailable and binds none of these values. Do
not add a browser DTO or cast, infer a thread target from `summary.id`, or read each row. Once present, bind the exact
target: use `reactionTarget` verbatim. The installed thread projector supplies its thread ID; never infer it from
`summary.id` or replace it with an opening post. A post target keeps its supplied post ID only after the native
thread/destination relationship is admitted. The count map uses the seven native kinds and positive integer entries;
an empty map means known zero, absent counts mean unavailable. Anonymous viewer-slot omission differs from
authenticated `null`, and a null watermark does not prove a later write converged. Following projection failure
withholds its rows and preserves its input frontier for retry.

Home receives the existing public verification configuration with its page result and reuses `PostActions` for
reporting. The row's canonical destination also feeds that owner's copy/recovery flow. Missing verification
configuration keeps reporting explicitly unavailable. The board caller forwards only `threadActivity`'s admitted
safe-integer reply count to the shared bar; a prepared fixture proves the receiving and exact accessible label, not
native delivery. The board owner keeps board-feed, pin and slow-mode files, keeps its localized reply destination,
and passes its installed report/author menu as `overflow`. `feedFeedbackEntries(locale, signedIn, href)` supplies
honest mute/hide entries for that menu. Keep pin/slow-mode entries with their current owners. No extra board read is
required.
Presentation is O(NR) for the native page cap (20) and fixed installed kind set. One explicit vote owns one write
and at most its bounded readback; sharing owns no kernel reads. The focused action-bar scenarios cover 1, 10 and 20
mounted rows, session/source retirement, receipt settlement/refusal, exact unknown retry, Home Continue, sign-in and
browser sharing recovery. Story responses are visibly prepared; inspect the signed-in/out, voted, refused, phone,
dark, long-string and keyboard variants at 390 and 1280 through the normal verifier.

## Reading a mixed Home card

`homeFeedItemPresentation` composes `card-presentation` and `card-attribution` into the existing ContentItem slots.
Kind and source precede the title; identity, disclosed related context and time follow it; the plain-text preview
comes last. Work covers and account avatars have independent destination links, alongside the primary row/title
link. Author, verified identity, reviewed Subject and image-credit links remain independent keyboard stops with
44px minimum targets. Continue keeps its progress state and its separate progress-session destination. FeedResults
and the reaction owner retain the actions slot; card reading adds no writes or action store.

Decision: show absolute, locale-formatted UTC feed-occurrence time, explicitly separate from supplied creation time;
null or invalid occurrence remains Unknown and never falls back to creation, progress or page `asOf`.

The installed destination discriminant selects work/Subject, discussion, reply, review, Collection, account or Space
presentation. A Subject is labelled Work only when `creativeWork` is supplied. Replies open their exact post query
and fragment, reviews open their thread rather than their reviewed Subject, and Spaces open their own admitted
address rather than a carrier Realm. An unreadable destination stays unlinked. Source copy names only Discover,
Following or Continue; it does not invent a followed person, endorsement, publication event or recommendation cause.

Only current supplied data is projected. Missing Content authors use Unknown account, not a claim of deletion;
provided identity labels are preserved, including labels describing deleted identities. A missing title retains the
owner's localized fallback. Missing cover/avatar renders the shared placeholder. No missing preview, author, count,
rating or Collection rule is hydrated or guessed. Image credit remains alongside the image with its licence and
HTTP(S) provider link; a non-web URL stays text. A suitability-withheld cover owns its reveal control and is not
wrapped in another interactive control or accompanied by hidden image credit. Long text wraps and previews retain
line breaks with a four-line visual bound. Title language remains the supplied label language.

Projection is O(N) in admitted rows plus supplied image variants: one main image and at most one author avatar per
row, no client, cache, effect, point read or scan. Replacing a row with withheld/missing data immediately removes its
old identity, preview, image and destination. Reader/session/source retirement stays with the existing Home owner.

### Native handoffs

- Content supplies author and excerpt on its installed thread/post summary. The current FeedAuthor has no deletion
  discriminator: web cannot distinguish deleted from unknown when no identity is delivered.
- Semantic summaries supply kind, selected label and cover, but no work credits, publication time, excerpt, ratings
  or endorsement counts. Those remain unavailable until supplied by the native feed contract.
- Reviewed-Subject metadata remains the pre-existing optional Home receiving seam; the installed generated native
  summary does not yet carry that field. No review target is inferred from title or fetched separately.
- Public Collection/review/Space discovery registration remains with Search. Home's existing pending Collection and
  Space seams do not make those branches natively available. Community must supply Space address/summary/carrier;
  a Realm never substitutes for a missing Space address. Collections expose no private rule or invented cover strip.

`10-feed-card-reading` stories use visibly prepared examples, including those pending seams, not native evidence.
They exercise the same shared FeedResults projection at 390 and 1280, in light/dark, long text and keyboard states.
The focused reading tests pin all installed branches, occurrence/creation meaning, independent destinations, missing
metadata and 1/10/20-row read cost; existing Home lifetime tests retain ownership of request and session retirement.

## Home selection context

Home and Following keep one selection owner for type, one exact-address Space and one rating question. The
`HomeFeedControls` surface consumes typed `HomeFeedFilterSummary` slots with localized labels, supplied metadata,
state and removal callbacks. It never inspects React labels, copies query state, fetches on open/close, or applies
an intermediate draft. Closing simply returns to the results. Search retains its independent interface.

Decision: use one mounted selector tree in a compact anchored desktop dialog and a bottom sheet below 640px;
selection is immediate and clear-all retains the stream, removes the cursor and issues at most one feed read.
The sheet contains a heading, localized close action and a persistent selected-context footer. Phone targets are
at least 44px. Opening focuses the first selector; Tab/Shift+Tab stay inside the surface, Escape/outside dismissal
returns focus to the opener, and phone modality makes sibling content inert and locks body scrolling. Individual
chip removal moves focus to the next surviving chip or its surface control. No second Apply step exists.

The narrow Home adapter synchronously retires every selection before bulk clear and suppresses only intermediate
store callbacks, then replaces the feed once through the existing window. In-flight metadata cannot restore a
cleared selection. Back/Forward still restores the exact native history descriptor and revalidates Space/question
metadata; account replacement retains the route's current-viewer remount boundary. FeedResults, card projection,
row actions and explicit next-page focus keep their existing ports. Local presentation does not add subscriptions.

Type choices use only the supplied bounded page; question choices use only the current question page plus the
retained selection. Page actions are explicit, replace the old page and do not enumerate other pages. The selected
Space remains one exact lookup plus its installed point validation. Projection is O(K+Q), plus one Space, and no
panel action creates discovery or Following sources. Missing native labels, Space directories, default questions
or additional choice methods remain unavailable producer features; Content/Community must supply those before
Home can offer them. Space context uses its supplied title/address only. Question context retains its actual
label, revision, grain, scale and review meaning. Failed restored metadata has an independently removable summary
and the existing retry, never an invented readable choice or a successful unfiltered feed.

`16-home-filter-context` uses visibly prepared responses for phone 390, desktop 1280, light/dark, long strings,
keyboard interaction, retained unavailable selections, delayed choices and account replacement. Its focused tests
pin clear/removal/history/pagination retirement and 1/10/100 supplied-choice growth without automatic reads.
