# Subject page composition

Subject templates place review and discussion regions through the shared community reader. The native page owns
identity, order, continuation and disclosure; the reader projects bounded titles, author ids, timestamps and
plain-text excerpts from the existing `subject_threads.list` response.

Decision: Until Content publishes the extended `subject_threads.list` response, current Subject cards are open-only; any
recorded citation without its own native scale and original target is shown as unavailable.

The installed `GET /v1/subjects/:id/threads` operation remains public `subject:read`. Content now adds required current
`context` and `reactionsAsOf` to `SubjectThreadsResponseSchema`, but the generated
`subjects({ id }).threads.get` declaration still exposes `{ threads: ThreadView[], next }`. It does not yet include
current page/place context, target-bound action variants, full citation scale/question revision/original target,
authoritative activity or source freshness. Its existing
producer is `services/kernel/src/content/subject-threads.ts`; the response schema is in
`services/kernel/src/content/schemas.ts`. Do not infer these fields from a readable thread, author, membership,
current vote or local policy. No admitted Content producer UUID, updated generated response head or
complete populated/withheld/failed card examples have been published for this extension. The partial native context
and reaction examples live in Content's [Subject threads contract](../../../../../services/kernel/src/content/README.md#subject-threads).

Decision: give every completed community read a fresh local visit identity, including a same-URL replacement; this
identity retires local effects and never substitutes for native context, freshness or action authority.

Visit cleanup retires only its captured visit. Returning to an earlier URL cannot revive it or let its cleanup retire
a newer visit. The lifetime also distinguishes locale, credential epoch and exposure when supplied by its caller;
the disconnected reaction exercise binds locale, while credential/session fencing stays in the command owner.

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
      Session preparation belongs to the existing public/private page boundary; projection adds no session request.
      A deliberate conversation open delegates commands and their readback to that conversation's existing owners.
- [ ] **Bound:** The card projection carries at most 20 rows and excerpts up to 280 UTF-16 code units; the direct
      helper and native query schema admit nonempty cursors up to 4096 UTF-16 code units. Returned cursors use the same
      bound, without decoding or rewriting. These are character limits, not byte bounds. A local observation key is
      one 36-character UUID per completed read. Content retains at most 20 native bodies of at most 2 MiB each, plus
      parsed documents, metadata and serialization copies; Web also retains the original page response. Media and
      action advice are not projected by this reader. Unbounded titles and unpublished complete card caps prevent a
      complete wire and retained-memory bound.
- [ ] **Growth:** Projection and indexing are O(N) for N≤20, with no refill, local totals or reordering. The native
      raw80 selection and 256/1024/4096 growth evidence remain Content producer checks; Web fixtures do not establish
      them.
