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
in the delivery's deadline. Every revision keeps a separate Search meter. The due scan discovers a ready revision
after interruption, and the ordinary enqueue path owns the final revision of each burst.

Cold Subject publication can continue the registration's original prepared bootstrap directly after reconciliation.
Search checks the physical incarnation and alias under its publication lock. Source reloads the exact definition,
checks the job's Source basis and revalidates the live registration before enrolling the next bounded page.
The completed page only advances enrollment. Opening the observation and publishing the generation still require
the normal custody, repair and writer-fence checks.
