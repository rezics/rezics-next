# Baseline enrollment receiving

`beginPublicFilterCoverageBaseline` pins the original registration generation before native home enrollment.
Each Access enrollment commits under its own writer-home locks and retains the compiler-key frontier, creation pin
and complete original receipt. The receiver verifies the exact committed receipt, active home epoch and creation
checkpoint for each home in a bounded page. It releases that read checkout before locking the Search registration.
Only the verified contiguous prefix is eligible for adoption.

The registration transaction retains the original predecessor and root per home and advances the receiver and
Source cursors once per page. The guards check the bounded chain from each old root to the new root. Source also
checks that every bootstrap account in a multi-home advance is present. Both cursors commit with all the page's
rows. An interrupted page can replay its committed Access receipts. A receiver that was one home ahead during
legacy single-home adoption reuses its original root. Empty homes still owe the original repair ACK.

Binding and receipt fields are copied before checkout. They must be own data fields on plain objects. Accessors,
proxies, coercible positions and out-of-domain scalars are refused before native work. The database proof and receiver
use the same snapshot.

## Cold Subject enrollment ranges

The version 1 native preparation input accepts at most four ordered, disjoint ranges on one funded offer for a
pinned, unpublished Subject job. Complete home enrollment rows and creation checkpoints are the durable range
evidence. Recovery reconstructs the same digest from those original rows, including for empty homes. No duplicate
payload needs a separate retention lifetime. Parallel preparation only enrolls the compiler keys and verifies
their committed receipts. It leaves the Search and Source cursors untouched.

The first Search page prepares two disjoint ranges in one Source call. Later pages can prepare one funded
Access group while the preceding page adopts. Each page pays for both retained binding reads and one adoption.
The Subject scan uses only a committed prefix. A failed predecessor leaves later original receipts available for
replay. Adoption rereads the whole batch under the native owner and checkpoint locks, verifies each range
digest against its own slice, and binds the existing Source and Search prefix to the same job, bootstrap,
definition, registration generation and incarnation. A gap returns pending. An overlapping retry appends only the
unadopted suffix with its original predecessors. The ordinary path can consume the same home receipts.
Observation, repair, ACK and serving use their existing authority checks.

### Cold Subject enrollment preparation and adoption

- Touches: Original registration and Source binding, Access writer-home enrollment and compiler edges, then the
  keyed home receipt and creation checkpoint. Adoption also writes the existing receiver baseline and both cursors.
- Bound: One offer reserves aggregate inputs and bytes before dispatch. Preparation reserves 24 fixed inputs plus
  26 inputs per home and two per compiler key per home, including a rejected fresh group probe and single-home
  fallback. Batched adoption reserves 24 fixed and 20 inputs per home. The combined worker path charges the
  shared definition and bootstrap reads once. Lookahead reserves another 16 inputs and 64 KiB for its second
  binding read. At most one lookahead page prepares alongside one ordered adoption.
- Growth check: The focused native enrollment fixture holds one predecessor, reads the later committed home from
  a second connection, and checks the unchanged prefix, batch rejection on digest or epoch drift, recovery and
  ordinary continuation.
  It records input keys, statements and bytes for the prepared pair.

## Shared subscription design

The next cold enrollment protocol opens a versioned retention hold for the native creation and privacy streams
before sampling any home. It registers the definition's keys once and persists a gapless cover of original home
cuts in bounded immutable pages. Cleanup will honor outstanding holds, and privacy maintenance will retain each
pending interval until its captured subscriber set is accounted for. The receiver will independently verify
the same native evidence before committing its own ACK. Persisted preparations retain their original protocol.

### Core retention boundary

On a co-located installation, the offline `core.enable_subject_retention_v1()` checks all 4096 active
homes under the placement lock. The migration starts in legacy mode. Enabling the Core guard makes
missing cleanup permission pending. Search admission still requires the privacy and receiver protocols.

At home 0, commit `core.open_subject_subscription_v1(job, bootstrap)` before taking the first cut.
Its returned `birth` identifies the original job, Source configuration, definition, meaning, consumer,
target generation, incarnation and at most 64 canonical compiler keys (16 KiB together). Privacy captures `core.subject_membership_revision_v1()` in the interval
transaction. It checks store and registration lineage and holds the membership and restore locks until commit. Seek `core.subject_subscription_key_v1(input_key,birth)`
through that revision and resolve each birth in `core.subject_subscription_v1`. A key captured before
birth belongs to the later subscriber's original population.

`core.capture_subject_retention_page_v1(birth, first_home, end_home)` persists the next half-open interval
of 1–32 homes. Each ordered entry binds home, epoch, home generation and the command and privacy positions
as decimal strings. Retrying the original interval checks current lineage and returns its original cuts.
Source must bind its Access revisions and enqueue carry to the same snapshot before using a page for enrollment.

Maintenance calls `core.advance_subject_cleanup_v1(home)`. A call examines at most 32 births under the
membership revision. An unresolved home returns pending. Each issued pair of inclusive positions is capped
by original cuts and native legacy pins. A live privacy key holds both grants at the previous issued
positions until its interval is accounted for. The local mutation checks the grant, both finite heads, restore
generation, physical store and home lineage. The guard covers the outbox, privacy log and the write-basis
transaction/epoch/position join. Acting-human provenance can still be cleared independently. A restore or
placement fence invalidates the grant. Distributed placements require routed owner coordination before admission.
Memberships and pages remain immutable through delivery and ACK. Closing them requires the future native
retirement proof covering outstanding fanout, readers, copies and repairs.

The native two-home fixture measured the following PostgreSQL user-table tuple visits and writes
with seven compiler keys. Each operation below is one SQL call. The write count excludes row locks,
index maintenance and WAL. Tuple visits exclude empty seeks and system catalogs. The guarded outbox update includes its local retention trigger.

| Operation | Tuple visits | Row writes |
| --- | ---: | ---: |
| Open membership / resolve original on retry | 16 / 16 | 9 / 0 |
| Capture two homes / recover original page | 25 / 29 | 1 / 0 |
| Issue permit before membership birth | 7 | 1 |
| Request permit for unresolved home | 8 | 0 |
| Issue permit at saved base / repeat | 10 / 11 | 1 / 0 |
| Minimize one permitted / held outbox slot | 23 / 7 | 1 / 0 |

The ordinary create and hide each appended two original event slots and one write basis. Hide added one
privacy-log entry. Both commands recorded zero scans and zero writes on the retention tables. The added
legacy minimum indexes track checkpoint position and home enrollment position on their respective paths.

## Subject receiver ACK protocol

The original Search preparation pins its ACK protocol at insertion. Production defaults to version 0.
Version 1 is reserved for a cold catalogue Subject job. Its receiver compares the original verified
creation windows, including empty homes, against enrollment, the retained creation checkpoint, Search
baseline and current coverage. A funded comparison waits for a complete leaf of at most 32 homes. Parents
bind the two adjacent child revisions. A complete root covers homes 0 through 4095 before Source closes the terminal.

Receiver changes update the affected subtree clocks synchronously. Loss of an original enrollment,
baseline or creation pin changes the preparation's continuity witness. Native owner, Semantic and
Access changes without a narrower witness can require a full comparison again. Each classified home
retains a separately indexed delta against its original native tuple.

Search commits one immutable manifest in the transaction that verifies and fences the original repair
settlement. Source locates it using its own terminal and checks the committed root, execution, observation,
settlement and continuity in the same transaction as its 0-to-4096 CAS. The trigger rejects adoption by
the inserting transaction. A later withdrawal keeps its pending key and current delta across historical
readback. Publication still reopens the settlement and original population start.

Population and Book withdrawal readers resolve the original manifest, terminal and retention clock in their
statement snapshot. The manifest supplies the ACK origin. Each home supplies the position, native enqueue
and nullable revisions from its immutable baseline. The explicit receiver operation proves that same tuple.
A higher materialized position requires independent settlement evidence before it can supersede the baseline.

Dirty reads seek the registration’s delta index. Book capture checks up to nine homes against its limit of
eight withdrawals. A missing cut yields pending. The changed-generation seek remains independent at population
start and final. Discovery uses its materialized ACK protocol. Ordinary v1 selection awaits composed serving,
writer admission, copy erasure and target retirement qualification.

## Serving from published catalogue coverage

Full Subject publication enrolls a catalogue-text key for label, alias, description, name-order and relevance
reductions. The same native outbox fanout writes this key alongside each matching exact dependency. Its receiver
uses the original enrollment, creation pin, verified terminal chain and contiguous ACK.

An eligible serving plan retains its own definition, bootstrap and observation. The bootstrap pins the exact job
and current receiver generation of a clean active publication whose coverage includes every compiled dependency.
The publication keeps its own coverage seal and its maintenance payload stays unavailable to serving. Each current
population read resolves the pinned publication again and applies the existing pending, fence, receiver-generation
and keyed own-row checks. A missing or incompatible parent follows ordinary independent enrollment at capture.
Later loss of the parent prevents the attached read from completing. The first attached request may retain a
single preparation segment within the existing prepared-page allowance. An unfinished build uses the ordinary
worker; recovery identifies the original observation by bootstrap and snapshot kind.

New catalogue publications also enroll the physical `name_sort` field. A first-public name-ordered Book TypeList
can attach after up to eight direct Subject withdrawals. Its predicate uses the original’s type and its order uses
that original’s labels and ID. Source checks the entire outstanding privacy interval against the moderation commands
and the ordinary writer’s refresh-visible settlements on the published incarnation. The PIT pins the withdrawn IDs
and receiver generation. Start and final recheck their current owners and visibility, and refuse any withdrawn ID
in the raw candidate window. A Subject born at an already advanced privacy position requires its original creation
command. Other reductions keep ordinary preparation and the catalogue receiver keeps its outstanding obligations.

## Preparation cost

Each home reserves 15 Access inputs, three committed-receipt inputs, nine coverage adoption inputs and seven
Source cursor inputs. Each compiler key adds two inputs for its enrollment edge and foreign-key check. The page
reserves five shared inputs for the registration owner, registration and preparation rows and the final Source
reread. Initial authorization, pinning and other fixed reads are charged before planning. Wide closures continue
the native key frontier and admit at most 450 keys per home per turn, or fewer when the remaining budget requires it.

Full Subject publication and mixed Discovery can enroll fresh complete key closures in groups of up to 16 homes.
Each group takes Core, Account and Source locks in order. A retained pin or receipt uses the single-home path with
up to three independent Access checkouts. Subject receipts omit Account and claim revisions.

With seven compiler keys for the cold Subject catalogue, the planner reserves 56 inputs per home including the
eight-input group probe. The 872-input maximum Search offer and five shared inputs admit at most 15 homes, so
4,096 homes take at least 274 enrollment turns. Each adopted page writes two durable cursors.

A default Search preparation delivery can claim exact ready revisions inline while Source advances and time remains
in the delivery's deadline. During cold Subject publication, one revision can enroll up to 32 Source pages under
the same publication lock. Each page keeps its own Search meter, revalidates registration custody and commits its
own receipt chain and cursor. The due scan rediscovers interrupted work and the next delivery resumes from the
committed Source cursor. The ordinary enqueue path owns the final revision of each delivery.

Cold Subject publication can continue the registration's original prepared bootstrap directly after reconciliation.
Search checks the physical incarnation and alias under its publication lock. Source reloads the exact definition,
checks the job's Source basis and revalidates the live registration before enrolling the next bounded page.
The completed page only advances enrollment. Opening the observation and publishing the generation still require
the normal custody, repair and writer-fence checks.
