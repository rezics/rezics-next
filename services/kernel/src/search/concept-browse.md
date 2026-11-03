# Concept hierarchy traversal

Search's hierarchy traversal is derived work beneath the existing retained-plan worker. It does not establish
Semantic graph coverage, release admission, disclosure or authorization. Native composition and the public
hierarchy journey are still to be installed; this module alone does not enable descendant filters.

Decision: hierarchy continuation follows sortable full native edge keys independently of returned child IDs, so
duplicate or irrelevant rows can advance without being mistaken for an empty closure.

`startConceptBrowse` copies and freezes the exact property/concept/scheme selection and the release, graph,
scheme, membership, principal and request binding before retaining the root. The state contains only this
bounded definition and a revision-fenced storage locator. It contains neither discovered keys nor frontier arrays.
An old version-one array state is rejected rather than imported as complete evidence.

`ConceptBrowseStore` is an internal derived-storage seam to be implemented within the existing retained-plan
lifecycle. The owning plan supplies immutable identity, leases, expiry, cancellation and worker dispatch. No
separate capture, scheduler, coverage record or public cursor is introduced. The store must persist membership
and frontier rows with full-key indexes, seed the root once, and atomically apply each bounded delta with a
revision CAS. A conflict must change no rows. A discovered key is enqueued only on its first insertion; cycles,
polyhierarchy, duplicate edges and interrupted-step replay must not expand it again. `read` returns at most one
frontier row. `seal` requires an empty indexed frontier. `contains` returns null unless the same retained revision
is sealed and usable; a membership Boolean includes the selected root but supplies no statement disclosure.
Retirement must invalidate membership immediately, with bounded row cleanup by the owning lifecycle.

Each traversal step observes its entire binding, seeks at most P child pages and examines at most E native edge
rows, then observes the binding again before returning resumable or completed work. A native child page carries
its full edge cursor even when it contains no distinct new child. Empty terminal seeks still consume a page.
A withheld, unavailable or incomplete branch cannot become a successful empty child page. Preparing evidence
remains resumable; unavailable, rejected, malformed and changed evidence retires the attempted revision.

For page size B, one step retains at most one frontier key and B child keys in working memory, independent of
total V/E graph cardinality. P <= 32, E <= 4096 and B <= min(256, E) are working-set limits, not closure-size caps.
The engine makes two binding observations, at most P child seeks, at most P + 1 single-frontier storage reads,
at most P atomic delta applications and at most one seal. Each delta deduplicates at most B keys locally;
the storage implementation must charge its indexed membership checks/inserts and frontier changes, including
conflicts. Total graph preparation must charge every native edge examined and every empty child seek, not only
newly discovered concepts. Retained storage is O(V); no step serializes or copies that population.

These are logical operation limits, not a measured all-pool native cost. Semantic's installed seek/fanout
constants, binding observations, current disclosure, authorization, History/source/control reads, retained writes,
cleanup, and useful result-page costs still require native composition and measurement. There is no population-
independent whole-page claim or 1x/4x/16x measurement here.

`currentConceptMembership` observes the full binding before and after a sealed membership lookup. A changed,
retired, unavailable or unsealed closure yields `not_proven`, including for an absent concept. The shared current
Boolean interpreter must preserve this value under exclusion, and the shared statement matcher must independently
prove the property, concept value, disclosure and spoiler qualifier on the same statement. Membership must never
be lowered to a bounded `statement.in` list or truncated to the filter's 64-value admission limit.
