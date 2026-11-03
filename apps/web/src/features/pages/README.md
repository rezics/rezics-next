# Subject page composition

Subject templates place review and discussion regions through the shared community reader. The native page owns
identity, order, continuation and disclosure; the reader projects bounded titles, author ids, timestamps and
plain-text excerpts from the existing `subject_threads.list` response.

Decision: Until Content publishes the extended `subject_threads.list` response, current Subject cards are open-only; any
recorded citation without its own native scale and original target is shown as unavailable.

The installed `GET /v1/subjects/:id/threads` operation remains public `subject:read` and returns the closed
`SubjectThreadsResponseSchema` shape `{ threads: ThreadView[], next }`. The generated
`subjects({ id }).threads.get` response does not yet include current page/place context, target-bound action variants,
full citation scale/question revision/original target, authoritative activity or source freshness. Its existing
producer is `services/kernel/src/content/subject-threads.ts`; the response schema is in
`services/kernel/src/content/schemas.ts`. Do not infer these fields from a readable thread, author, membership,
current vote or local policy. No admitted Content producer UUID, updated generated response head or
populated/withheld/failed examples have been published for this extension.

`voteCitation` remains historical first-post context, never the author's current rating. A null citation is
unscored; a present citation without its native scale and original target is unavailable. Omitted reaction counts
mean the count projection is unavailable; omitted kinds inside a supplied count object are zero. An absent viewer
slot is withheld, while explicit `null` means the current reader has no reaction. Public page output removes viewer
slots; private reader-keyed page results keep their no-store boundary. Reaction, reply and creation controls stay
unmounted until their target-bound native advice is available.

Subject community leaves retain their native cursor and five-row overview/twenty-row full-page limits. One shared
author batch serves each composition page. Missing reply-count and last-activity fields stay unavailable under the
Content-owned conversation-activity contract; timestamps and loaded page length do not stand in for them. Readable
titles open the admitted thread; Board links remain read destinations. See the [Web page requirements](../../../../../docs/goals/web.md#adopted-core-page-experience-requirements).

## Cost

- [x] **Touches:** Each full discussion or review view consumes one planned native page at limit 20 or less; the
  overview keeps its existing five-row preview and one shared author batch. Opening a conversation is deliberate.
  Explicit retry repeats its cursor. Current Subject cards issue no per-card hydration, mutation or readback.
- [ ] **Bound:** The card projection carries at most 20 rows and excerpts up to 280 UTF-16 code units; the direct
  helper caps cursors at 2048 characters and the native query schema at 4096. These are character limits, not byte
  bounds. Unbounded titles, the retained source response and unpublished media/citation/action/context caps prevent a
  complete wire and retained-memory bound.
- [ ] **Growth:** Projection and indexing are O(N) for N≤20, with no refill, local totals or reordering. The native
  raw80 selection and 256/1024/4096 growth evidence remain Content producer checks; Web fixtures do not establish
  them.
