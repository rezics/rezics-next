# Realm reply operation template

The first write/read template is `POST /v1/realm-replies` plus the exact Realm
placement read in `routes/realm-replies.ts`. A reply body is saved through the
existing Content draft API. `content-store.ts` binds its immutable reply identity
to that variant and revision, then writes an owner receipt/outbox in one Content
transaction. `store.ts` claims Access authority and seals it from an immutable
Jena terminal receipt. `graph.ts` supplies that receipt and the generated
`realm-reply-placement-v1` slot/placement command. Copy these four files and
`receipt-family.ts` when extending this operation family; keep each new receipt
action in the Content action registry and its Access graph family mapping.

A review decision names one Realm, one exact Content revision and digest, one
policy epoch, one method revision and dependency digest. Editing a later draft
does not move an approval. Placement pins the approved revision through the
existing Content publication preparation, validates its Realm-local graph slot,
and settles the pin from the terminal graph receipt. A cancelled command settles
it as rejected. A graph result with no readable terminal receipt remains
unavailable for retry; the same admission ID can recover a committed Content
preparation after a lost response. Exact and count reads recheck the current
Content review, so revocation suppresses visibility without erasing history.

Each write uses fixed indexed owner probes and one graph command; a retry reads
one Content receipt, one graph receipt and at most one placement slot. SQL work
is O(log h) per probe for retained history `h`, with constant selected rows and
response bytes. A root count reads at most 65 graph slot heads and validates at
most 64 exact Content reviews; `complete: false` marks a truncated result. It
uses O(64 log h) bounded work and O(64) memory. The separate Commerce recovery
cut in `../commerce/recovery-coverage.ts` streams each owner table in 128-row
chunks in one repeatable-read transaction; it is O(n) in retained owner rows and
O(128) memory. The global recovery release must include that cut before a
pre-revocation Commerce snapshot can be rejected at release.
