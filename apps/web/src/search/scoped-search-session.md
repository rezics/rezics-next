# Search session boundary

Search binds a read to the current server session whenever the authored request contains Realm or Collection
membership, an ordinary viewer-self `owner` predicate, or a nonempty canonical `ratingPopulation`. The rating population is an order basis, not a membership
predicate. Blank or absent population means Global; invalid nonempty input remains correctable.

Reader selection walks the released discovery grammar in both `filter` and `condition`, including owner leaves
under AND, OR and NOT. Library remains ordinary `owner.presence`, with no additional resource scope or account selector.

```ts
export type ScopedSearchReader = Readonly<{
  owner: string; // identity hint for query ownership; never authorization
  principal: string;
  authorization: string; // current viewer credential from the server session
}>;

export async function readScopedSearchReader(request: Request): Promise<ScopedSearchReader | undefined>;
```

`readScopedSearchReader` runs only on the server. It calls `prepareSession(request, env)`, then reads
`sessionSubject(request)` and `viewerCredential(request)` from that same request. It returns no reader unless both are
present, sets `Cache-Control: private, no-store`, and derives `owner` from the current subject. A browser-supplied
owner is compared with this value and cannot supply an actor, credential or grant. Kernel calls use the returned
credential and the request's abort signal.

Public Search with no owner predicate, resource membership or rating population remains anonymous and may use the public route cache
and dehydration. Any session-bound Search starts in a browser query and is keyed by the complete URL-derived state,
locale, read mode and current owner. A basis or owner change unmounts the previous query, removes its results and
refinement options, and cancels or quarantines its late response. Personal queries have no retained cache time.

The route uses the same boundary for Search results, kind continuation and facet reads. A missing or changed session
returns the existing session/unavailable recovery state. Protected Realm rating order has no installed Content
complete-order adapter in this Web contract, so it remains selected and returns unavailable without issuing a Global
rating request. Global rating remains the existing public Search order.
