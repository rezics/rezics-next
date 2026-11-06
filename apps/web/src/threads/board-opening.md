# Native Board opening receiver

## Installed Content source

Content now has a source-side opening reader and a mounted `GET /v1/boards/:id/page` route. Its operation is
`board_page.get`, exposed as public `content.board` with the `thread:read` action. The response is private and
`no-store`. The closed response schema contains one `board`, `pinnedThreads`, ordinary `threads`, opaque `next`,
`rankRefreshedAt`, `reactionsAsOf`, viewer participation and create-thread advice.

Each card contains the current `ThreadView`, its exact thread and Board target, separate thread/opening-post author
availability, media availability, reaction counts with a freshness witness or an explicit unavailable state, viewer
reaction state, current conversation comment evidence or an explicit unavailable state, and reply/react/share advice.
Missing reaction count keys stay missing; zero and unavailable remain distinct. A current comment witness carries an
exact or lower-bound count; Web preserves that operand and does not derive totals from loaded rows. Pin, watch and
slow-mode commands retain their existing owners.
reaction state, request-bound exact/lower-bound conversation comments or unavailable comments, and reply/react/share advice. Missing count keys stay missing;
zero and unavailable remain distinct. Only a current cohort witness supplies a comment count; unavailable witnesses supply no total. Pin, watch and slow-mode
commands retain their existing owners.

The source query admits `new`, `active` and `hot`, with a cursor of at most 4,096 characters. Content selects at most
five initial pins and twenty ordinary candidates in native order. Continuation advances the ordinary source, keeps
the initial pin exclusion cohort, and preserves sparse `next` pages. A rejected continuation must retain its exact
input for retry; `invalid_cursor` requires an explicit first-page restart with the same Board and sort. A malformed
query, rank-not-ready result, denial, signed-out advice, closed Board and dependency failure keep their distinct
native outcomes. Web does not refill sparse pages or derive activity from loaded rows or revision timestamps.

## Web receiving status

Decision: use the mounted Board page as the sole source for opening cards and inline action advice; keep the existing
membership command's own settlement reads and the pin, watch, and slow-mode owners.

The generated client now exposes `boards({ id }).page.get` and `BoardPageResponse`, derived from the mounted route
declaration. `loadBoardPageWithAuthors` sends the selected cursor and sort, forwards the selected reader credential,
and maps that response through the existing Board caller. It does not issue separate Board, Realm, thread-list, or
author reads. The response remains private and `no-store`; the caller still checks its reader, cache owner, route,
locale, and session before publishing it. A concealed Board remains not-found, and a failed read remains an error.

The producer factory contract is `createBoardOpeningPageReader(dependencies)`, returning
`readBoardOpeningPage(boardId, { actor, deadline }, { cursor?, sort?: 'new' | 'active' | 'hot' })`. The installed
activity reader seam is `readConversationActivityBatch(threadIds, { actor, deadline })`, returning
`{ items: BoardOpeningActivityWitness[], anchors: AnchoredPosition[] }`. A current witness binds a thread to a public
or matching viewer cohort, an exact or lower-bound count, last activity time, and source epoch/position; a withheld
or unsupported witness returns `{ state: 'unavailable', threadId }`. Selected count and source fields are copied before
hydration so a producer's in-place refresh cannot rewrite the initial observation.

The mounted response head is `board`, `pinnedThreads`, `threads`, `next`, `rankRefreshedAt`, `reactionsAsOf`,
`viewer`, and `actions`. Each card includes `thread`, `target`, `authors`, `media`, `interaction`, `comments`, and
`actions`. These examples show the consumer contract:

```ts
// Populated public observation; lower-bound counts keep their meaning in the UI.
comments: {
  state: 'current', cohort: 'public', count: { kind: 'lower-bound', value: 4 },
  lastActivityAt: '2026-11-04T00:00:00.000Z', source: { epoch: 2, position: '10' },
}
interaction: {
  target: { kind: 'thread', id: threadId },
  counts: { state: 'as-of', values: { like: 3 }, source: { epoch: 2, position: '12' } },
  viewer: { state: 'not-applicable' },
}

// Withheld comment or interaction evidence has no fallback read; exact zero is distinct.
comments: { state: 'unavailable' }
comments: {
  state: 'current', cohort: 'public', count: { kind: 'exact', value: 0 },
  lastActivityAt: null, source: { epoch: 2, position: '10' },
}
interaction: { target: { kind: 'thread', id: threadId }, counts: { state: 'unavailable' }, viewer: { state: 'not-applicable' } }

// Failed and changed-witness responses carry no partial page; retry the exact input.
HTTP 503 { code: 'dependency_unavailable' }
```

Reply actions display a current exact comment count as an exact number and a lower-bound count with a trailing `+`;
missing, unsupported, negative and unsafe counts remain unavailable. The accessible name keeps the exact localized
operand and the existing reply destination. Prepared fixtures prove receiving only, not native delivery.

The reaction aggregate only supplies a target summary when at least one installed target row carries a source
watermark. Its zero-valued kind rows are retained as tombstones, so omitted kinds in a represented target are zero;
an entirely absent target row cannot prove an exact zero. The page reads per-target freshness and compares the
selected aggregate with the final aggregate during hydration. A changed summary fails the whole request with retryable
`503 dependency_unavailable`; Web never uses the old `ThreadView.reactions` field as a fallback. The returned
`reactionsAsOf` is page-wide, while each card retains its own target source. An `epoch`/`position` stamp identifies the
installed snapshot; by itself it is not a source-checkpoint certificate. Source retirement starts a new epoch, so an
old stamp cannot establish that every new-epoch source event is represented. Treat these counts as `as-of`, preserve
their per-target source, and leave an absent or changed summary unavailable until the producer supplies a new
observation; do not substitute a page-derived count.

The envelope supplies current create-thread, reply, and react advice. Web uses those values to decide which entry
points to render; the native command remains authoritative. Membership's existing command and post-command
verification remain in its owner. Pin, watch, and slow-mode commands remain with their existing owners. Readability,
membership labels, and successful reads do not grant contribution or moderation authority.

Decision: the thread receiver consumes the mounted reading page's exact-revision review citation, mention and image projections without browser-side enrichment; historical question metadata stays unavailable, and local revisions cannot borrow the previous document's projections.

## Evidence boundary

The source schema and mounted route establish the producer implementation. The generated client and Web reader are
now bound to that route, but fixtures and type assertions do not establish native authority, revocation, hydration
witnesses, physical growth, or visual layout. Native persona, source-retirement, revocation, continuation, growth, and
strict physical-plan runs remain part of controller acceptance. Phone and desktop, theme, keyboard, and locale review
also remains part of controller acceptance.

Board activity is current only when the response carries its request-bound cohort witness; unsupported cohorts stay unavailable. A01 and A02 Home findings are not satisfied by a
Board page, and A08 is not satisfied by post revision time or the loaded reply window. Keep existing plaintext,
preview bounds and author-declared spoiler reveal behavior when composing the admitted `ThreadView`.

## Card and command presentation

Decision: Board previews show one admitted opening image and keep spoiler text and that image behind an explicit reveal when the preview contains spoiler marks; native counts lacking either vote operand use chips rather than a derived vote score.

Decision: Community membership advice supplies no Realm visibility, so the membership owner receives `unknown` visibility with the exact join/leave advice; signed-in Board reactions are admitted only for native allowed advice, a current viewer slot, and the reader bound to the current Board page, then settle through the owner's exact target readback.

Authors are scoped to each card's separate thread/opening projections. A disclosed identity elsewhere in the response
does not fill a withheld projection. Media comes only from the same opening response and the opening post's declared
media IDs; no presentation or author requests are issued. Explicit pin refresh uses the same generated opening method
and replaces context, cards, advice, media and authors together. Pin commands, unknown-command retry and invalidating
revision handling remain in the pin owner. The reaction owner receives the exact native target and sign-in advice.
Missing reader, page currentness, native permission or a current viewer slot leaves the reaction unavailable. An
admitted write always settles through the owner's exact current read, which must meet the selected count watermark
when one was supplied; the owner keeps the original retry operands and discards late reads after source retirement.

Decision: composed Subject community cards block further reaction choices while their explicit command is pending.
The shared control keeps its mounted queue and optimistic view during this lock; equal component registries
cannot replace the native command owner or its retry operands.

A thread return descriptor may retain the disclosed row ID for focus. It carries no title, author or credentials.
Returning reads the current Board source before focusing that surviving row, or the feed heading if it disappeared.
The continuation bound is the installed 4,096-character Board cursor limit.

Consumer measurements at selected cohorts 1/10/25 report one request per read, selected rows, serialized response bytes
and retained rows. Varying unrelated prepared rows tests consumer independence only. It is not a native physical-growth
measurement. Content persona, revocation, physical-plan and independent-cache first-paint deferrals remain unchanged.
