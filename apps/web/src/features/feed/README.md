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
