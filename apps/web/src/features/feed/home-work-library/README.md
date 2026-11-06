# Home personal facts and actions

Decision: Home maps the installed `viewerPersonalActions` page into this seam once per feed window snapshot. Replacement,
loading or sign-out retires those facts; missing or unavailable native facts stay unavailable; no control callbacks are
installed; and facts remain separate from permission.

Decision: Fact reconciliation retains its original source lifetime; only a new source observation can admit fresh facts after retirement, including replacement back to the same reader.

The local presentation model is not a transport declaration. Content owns composing
`FeedDependencies.viewerPersonalActions` into the existing Home page and rechecking source admission after foreign
work. The receiver must consume that one page using original occurrence keys and original Subjects. It must not
plan another personal query, deduplicate by Subject, reindex surviving rows, refill positions, reconstruct source
admission or change the feed's original cursor and source filters. The 100-row bound applies before deduplication;
native input and full-response byte bounds remain with the producer.

`HomeWorkLibraryAction` receives the feed item's original occurrence ID. Catalogue navigation without an admitted
occurrence retains its exact Library destination and cannot borrow a matching Subject's private row. An unavailable
or malformed occurrence does not withdraw unrelated rows. Missing rows are unavailable, never absent facts.
An acknowledged command can reconcile facts across repeated occurrences only while its original occurrence and
reader/source observation remain admitted. Reconciliation keeps occurrence keys and action advice unchanged.

Facts and permissions are independent. Current `allowed=[]` is a successful reading with no actions; an Entry,
visible Work or authenticated reader grants no commands. The fact-only prepared seam installs no private mutation
callbacks. It uses the shared session observation adapter to retire private presentation on reader or credential
replacement, including replacement back to the original reader. Its current lease and exact scope are also required.
Public Home reads and the existing Library return destination remain unchanged.

Native integration must use the installed generated response and existing Entry/progress and manual vote writers,
with exact advised operations and original command operands, credential and idempotency key. Manual vote requires
the current standard question `00000000-0000-7000-8000-000000000001`, revision 1, scale 0–20 step 1. Public review
scores cannot supply the reader's counted vote. Withdrawn occurrences and replaced readers must retire command
callbacks and delayed completions. Shared observation remains with the existing retirement adapter.

The installed generated response supplies the HTTP contract. Web still imports no Kernel server code, adds no endpoint,
casts no client and handwrites no native declarations. The receiver installs no writers: Entry, progress and vote
commands stay with their existing owners. Public-owner cards remain with their existing continuation.
