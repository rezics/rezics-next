# Baseline enrollment receiving

`beginPublicFilterCoverageBaseline` pins the original registration generation before native home enrollment.
Each Access enrollment commits under its own writer-home locks and retains the compiler-key frontier, creation pin
and complete original receipt. The receiver verifies the exact committed receipt, active home epoch and creation
checkpoint for each home in a bounded page. It releases that read checkout before locking the Search registration.
Only the verified contiguous prefix is eligible for adoption.

The registration transaction retains the original predecessor and root per home. Each receiver advance and its
Source cursor CAS now commit together. An interrupted page can replay its committed Access receipts. A receiver that
was one home ahead before this change reuses its original root. Neither interruption nor an empty home grants a
repair ACK, changes the covered cut or allows the Source to seal early.

Binding and receipt fields are copied before checkout. They must be own data fields on plain objects. Accessors,
proxies, coercible positions and out-of-domain scalars are refused before native work. The database proof and receiver
use the same snapshot.

## Preparation cost

Each home reserves 15 Access inputs, three committed-receipt inputs, nine coverage adoption inputs and seven
Source cursor inputs. Each compiler key adds two inputs for its enrollment edge and foreign-key check. The page
reserves five shared inputs for the registration owner, registration and preparation rows and the final Source
reread. Initial authorization, pinning and other fixed reads are charged before planning. Wide closures continue
the native key frontier and admit at most 450 keys per home per turn, or fewer when the remaining budget requires it.

With four keys, the default Subject home costs 42 inputs. With the 872-input maximum Search offer and five shared
inputs, at most 20 homes fit, so 4,096 homes need at least 205 enrollment turns. With 64 inputs already charged,
19 homes fit and 216 turns suffice under that fixed offer. The ordinary cold path drops from 30 SQL statements per
home to 18 per home and 10 shared statements per page, excluding fixed turn work. At most three independent Access
checkouts can run concurrently, each holding only its own home.

A default Search preparation delivery may claim up to four exact ready revisions when Source reports durable
enrollment progress. Every revision keeps its separate Search meter and shares the delivery's existing deadline.
At 216 turns this allows 54 deliveries with uninterrupted inline claims. The existing due scan discovers a ready
revision if inline continuation is interrupted, and the ordinary enqueue path owns the final revision of each
burst. Materialization, repair and writer fencing still receive their own scheduling and evidence.
