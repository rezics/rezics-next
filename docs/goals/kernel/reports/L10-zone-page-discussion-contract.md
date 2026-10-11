1. **Identity and attachment**

   `about` is the resource returned by the Zone route owner: the published home document, mounted document, Work or generic resource. It is never the Zone, route string, language, tag or resource revision.

   The canonical key is `(realm, about)`. Two Zones attached to the same Realm and displaying the same resource share its discussion. A different Realm has a separate discussion. Page edits preserve the canonical thread.

   Consume the live Realm link from Zone configuration/route reads. Do not infer it from the Zone Space’s co-located Realm capability: a cross-Space attachment can name another Realm.

2. **Bounded lookup**

   Proposed operation:

   ```text
   GET /v1/realms/{realm}/about-thread?about=<resource>&actingSubject=<optional>
   ```

   Return a singular result containing `realm`, `about`, and either `thread: null` or the canonical opener’s identity and retained root revision. Use existing thread reads to load its content.

   Perform one indexed canonical-key lookup, one exact placement/review check, and fixed Realm/target disclosure probes. Return no collection, count or cursor; propose a 64 KiB response ceiling. Do not scan Realm lists or select the first matching thread from a capped sample.

   Hidden thread and absent thread both return `thread: null`. Hidden Realm/resource and nonexistent Realm/resource both return the same 404. Unavailable owners return 503, never an empty result. Apply current membership, history-floor, moderation, erasure and target-disclosure checks, including fences against changes during the read. Lookup creates no discussion or reservation.

3. **One posting command**

   Proposed operation:

   ```text
   POST /v1/realms/{realm}/about-posts
   Idempotency-Key: <one intent key>
   ```

   Input contains `about`, the observed target revision, document/body, writing language, optional spoiler declaration, acting Person, and the originating Zone route/attachment basis. The server resolves and checks that route, resource and live attachment. Clients cannot supply the canonical opener, parent, approval or retained-root bypass.

   The realm-reply owner performs draft creation, identity insertion, placement and settlement using existing owner operations and stable phase keys. The browser sends one intent and receives one outcome.

   Outcomes:

   - **201 posted:** return canonical thread, this Person’s reply, placement and whether it opened the discussion.
   - **200 replayed:** same committed result for the same actor, key and input.
   - **202 pending:** durable operation identity; resubmitting the same command resumes it.
   - **409:** changed input under the same key, or a stale visible route/attachment/root basis.
   - **401/403:** authentication or applicable admission refusal.
   - **404:** hidden/missing target, Realm or canonical parent.
   - **503:** recoverable dependency failure; retain the intent and resolve receipts before further effects.

   Preserve omitted versus explicit spoiler values and the author’s chosen language. A changed post is a new intent; retrying an uncertain post retains its original key and payload.

4. **Uniqueness, races and recovery**

   Add a canonical-key record and durable operation progress inside realm-reply’s existing storage owner. A database unique constraint on `(realm, about)` chooses the opener before immutable reply identity insertion. This is an owner index, not another forum or authorization mechanism.

   It constrains the canonical page discussion; it does not prohibit unrelated Realm posts about that resource.

   With concurrent first posts, the winner opens the thread. The other command preserves its own Person, body and language and becomes a child of that opener. A pending opener makes the second operation pending until the owner resolves it. It must not create a second root or silently discard either post.

   Keep storage transactions short; do not hold SQL locks across Content/Jena calls. PostgreSQL documents that conflict handling can encounter rows outside the current statement snapshot, so follow-up winner reads and retries must be explicit. This supports the mechanism choice, but cross-store correctness still requires repository integration tests. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

   Resolve ambiguous effects through existing immutable receipts. Release an unsuccessful reservation only after terminal rejection establishes that no placement succeeded. Once activated, a hidden, revoked or erased canonical opener cannot cause automatic allocation of another thread.

   Set `originRealm` on every new contribution. Partial or refused operations must not expose stray public replies. Owner recovery and settlement handle cleanup.

5. **Posting authority and retained roots**

   Attachment grants neither membership nor posting authority. C1 decides Person control, eligibility, bans, representation, membership generations, expiry and revocation. Compose existing `content.draft`, `reply.create` and `reply.place` actions; no new admission service or action is needed.

   - Public `open`: eligible Person may post directly without membership.
   - `trusted-members`: direct placement requires approved participation/owner mandate.
   - Private Realm: requires its admitted participation and applicable policy.
   - `mandatory`: requires exact moderator approval. The direct command returns the existing review-required restriction before creating effects; it cannot synthesize approval. A new review-submission journey is separate scope.

