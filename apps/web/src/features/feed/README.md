# Feed results

`FeedResults<T>` is the shared ordered list, availability, empty-state and recovery region. It renders one named
`section` and an `ol` or `ul` of `ContentItem` rows. It does not add a page landmark or heading; the caller keeps its
page heading and section hierarchy.

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

Home's native `FeedItem` projection is `homeFeedItemPresentation(item, locale)`. It retains the installed title,
canonical destination, cover/avatar, language, preview, source and occurrence attributes, Continue progress, and
the separate resume link. Collection, review and Space rows use this same adapter: a Collection keeps
`/collections/{id}` with its supplied title and description; a review keeps the thread destination and optional
disclosed reviewed-Subject context rather than becoming its target Subject; a Space keeps `/spaces/{address}`
when that address is readable and shows a Realm title only as carrier text. The adapter is not a native summary
union, performs no reads, does not rank or apply public/private predicates, and omits missing author, excerpt,
image and rating. Following Collections and review threads are consumed when Content discloses them. Public
discovery Collection, review and Space kinds remain Search's pending registration. Space feed rows use the named
`HomeSpaceFeedItem` seam until Content/Community deliver that branch.

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
Do not pass a fabricated current predicate to retain an old private snapshot.

`VoteControl` delegates to `ThreadReactions` and the shared `Reactions` queue. It does not implement another vote
engine. Fresh feed commands reconcile through the existing single-target point read; `settleWithRead: false` lets
an existing detail owner retain its existing refresh callback. Unknown writes retain only their immutable current
visit command and explicit retry. A refused change restores the last projection and announces the native failure.
No command runs on mount or on a session observation. Account/token replacement and away/back retire old callers.

`reply` accepts an existing reply-intent callback or an admitted link; missing reply destinations remain unavailable.
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

Content's generated `feedItems.get` summaries currently pick thread/post identity, title and creation metadata only;
they supply neither reaction counts nor the viewer slot. Home deliberately renders unavailable voting until Content
delivers those fields in the same bounded page, with source privacy and current-reader admission. No browser DTO or
per-row read fills that gap. Content also needs typed mute-author/hide commands before those menu entries can act.
Home receives the existing public verification configuration with its page result and reuses `PostActions` for
reporting. The row's canonical destination also feeds that owner's copy/recovery flow. Missing verification
configuration keeps reporting explicitly unavailable. The remaining Home vote projection and feedback commands
are described in `.temp/continuation/feed-actions.md`.

The board owner keeps board-feed, pin and slow-mode files. Import `FeedActionBar`, pass each existing thread's actual
reaction counts/value and current-source origin, keep its existing localized destination and reply route, and pass
its installed report/author menu as `overflow`. `feedFeedbackEntries(locale, signedIn, href)` supplies honest mute/hide
entries for that menu. Keep pin/slow-mode entries with their current owners. No extra board read is required.

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
