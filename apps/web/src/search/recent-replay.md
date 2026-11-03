# Repeating a Recent search

Query history stores text, up to eight ordered languages and an optional native scope reference. A query repeats
on `/search` with `q`, repeated `language` and the installed `filter` resource leaf (`realm` or `collection`, with
one UUID `id`). A scope-only record still browses its resource. No arbitrary predicates, rating order or cursor are
saved. Both Recent consumers reconstruct the same canonical destination. Native page admission compares decoded
meaning; escaping and field order may differ, but duplicate scalar fields, foreign fields and changed operands fail.
Account storage retains references and query meaning only; scope names and actions require current native reads.

Decision: Library query records remain retained but unavailable until the Search producer exports a Library resource
operand; `SearchResourceScope` and `parseSearchResourceScope` currently admit only Realm and Collection. A Library
scope-only record still browses Library. Recent must not invent an operand or turn this missing reader into Global.

Recent's native schema admits 256 UTF-16 units of text, eight language tags of at most 35 units, 100 account rows and
20 rows per page. Local history retains 32 entries. Destination evidence is capped at 8192 URL units before decoding;
the installed Search URL admits 512 UTF-8 bytes of query text, eight language tags and a 16384-unit filter. Its
filter grammar limits depth to four, leaves to 32, OR children to 16 and IN operands to 64. A Recent resource
predicate uses one leaf. Missing languages (including an empty selection) use the Search locale fallback.

For a selected record of encoded size R and L languages, reconstruction/admission costs O(R + L + F), with one
resource leaf F = 1. Rendering, sync, expiry and retry dispatch no Search result reads. An explicit link activation
navigates to the installed Search route, which owns its session-bound reader and final native admission. Reader or
account replacement retires sync publication and mounted activation. Recent does not add a second reader invocation.
The existing native reader cost remains Q(F, L, 100), including preparation, sparse rejection, current disclosure,
retained candidates and final admission; its total resumable work is separate from a page's limit. Growth admission requires native three-scale execution and Performance review of unresolved native terms; focused
tests alone cannot establish that bound.
