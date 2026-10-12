# Read ranking population cuts

The global Trending, Realm rankings and Realm Rising APIs order the admitted
population at one published Access cut. A cut is keyed by
`(generation, context, metric, interval, bucket, published revision)`: context is
`urn:rezics:context:global` or the Realm IRI. Score and growth ordering share the
population revision; the cursor additionally binds its ordering and language.

Access captures the revision, checkpoint diagnostics and bounded candidate rows
in one SQL statement. A revision identifies the materialization that actually
committed, including successful targets beyond a retained failure. It does not
claim a complete source prefix. `contentPosition` remains the conservative
source coverage position. Pending additions stay absent until projection applies
them; source lag and unrelated context, metric or bucket writes do not close a
usable cut. The page count remains `exact-page` with `total: null`.

Continuation requires the same published population revision and recovery epoch.
A changed population returns `read_basis_changed` (409), asking the client to
restart. An addition after page capture may publish a later revision without
closing that captured page. Admission refresh preserves unchanged score rows so
updates in another metric or bucket do not manufacture a new revision.

Removal safety comes from the existing owners:

- Access scope and governance transitions synchronously update the admitted
  index. Before delivery, an exact bounded probe checks every captured candidate,
  including the continuation row, still belongs to that population. Removal
  retries a first page or expires continuation; a removed row cannot supply an
  item, count or continuation hint.
- A negative Review source event synchronously records a pending removal for its
  Work's global and admitted Realm contexts, each interval's original bucket and
  following bucket (whose growth depends on the original score). Only effects
  with a matching admitted score fence a population; a never-admitted Work's
  failed addition and removal stay pending without closing existing reads.
  Admitted-row transitions maintain that membership in the source transaction. New context
  admission inherits outstanding removals. Only those Review populations return
  `rankings_incomplete` (503) until the score effect and removal acknowledgement
  commit together. Failed or target-blocked negative replay keeps the fence.
  A per-population removal watermark also refuses a captured page when negative
  replay finishes before its delivery probe, even if the Work still has a lower
  nonzero score. A fresh page then admits the updated materialization.
- A rebuilt generation initializes Review populations through the captured
  historical replay horizon, so an old removal cannot be rediscovered after a
  partial Review population was already served. Failed additions at that horizon
  remain pending; discovered failed removals retain their scoped fence.

Selected Works still undergo live graph publication, summary and disclosure
checks. A captured cut grants no authority. Recovery hold, lineage mismatch,
corrupt retained coverage, missing generation and owner rewind still refuse
admission. Graph dependency checks are bounded to consumed facts rather than the
whole graph position.

These reads use PostgreSQL's [statement snapshot semantics](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED).
They do not require a native Java change. Realm Best/Top thread rankings and
personal Home Trending have separate establishment and delivery contracts.
