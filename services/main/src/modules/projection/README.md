# Projections

A Projection is one Resource naming a subject within a frame: exactly one
`rv:projectionOf` and one to eight `rv:frame` coordinates
([decision 51](../../../../../docs/contracts/semantic-model.md#identities-variants-and-projections)).
Ratings, reviews, discussion and pages target "Misaka in *Railgun* S1 episode 3"
through it, with no second target kind. A projection is immutable, is not a member
of its subject's type, has no facts of its own and is never a subject or a frame.

`POST /v1/projections { subject, frames, actingSubject }` gets or creates the one
projection of a subject and sorted frame set; `GET /v1/projections?subject=…&frame=…`
looks one up without creating it and `?subject=…` pages a subject's projections.

## Identity

`schema.ts` hashes the subject and the sorted frames into a key. The Access table
`access.projection_identity` is unique on it (migration 1050, which also checks the
hash). The admitted `projection.create` command reserves the row, recording its
admission, and then commits the graph Resource under that identity. Concurrent first
uses all reserve through one `INSERT … ON CONFLICT DO NOTHING`, so every caller names
the first caller's UUID, and whichever command reaches the graph first creates the
Resource. A command whose guards find it already created is sealed cancelled with no
graph effect, and its caller answers with the existing projection. A reserved identity
whose command was lost is adopted by the next caller.

## Frames

Each frame resolves through the shared target resolver and must have a dimension:
Work, realization, release and Structure position by their grain (`dimension.ts`),
descriptive types by the registry's `frameDimension` (`schema:Event` is an event,
`rv:NarrativeContinuity` a continuity). A type without one, so a Realm, Space,
Context, Agent, unit or title, cannot be a frame.

The four structural kinds stay distinct (acceptance policies persist them) but a
frame holds one coordinate per **slot**: a Work or Structure position, a release or
realization, and each other dimension. `normalizeFrame` gives "X in F" one key: a Work
that a position, release or realization lies in is implied and dropped, so
`{Work, chapter 3}` is `{chapter 3}`; coordinates of different Works
(`projection_frame_work_mismatch`) and two coordinates in one slot
(`projection_frame_slot_repeated`) are refused. Frame reads (`?frame=`) normalize
the same way.

Coverage has one implementation, the SPARQL pattern `framePattern` in
`frame-read.ts`, applied before keyset pagination and tested on a real graph.
Typed applicability holds throughout a frame when values in a dimension (OR) and
across dimensions (AND) are each named by the frame or contain it: a position by
its Work and by any Structure group above it (the `rv:parent` chain of its
placement in the selected generation, at most `STRUCTURE_LIMITS.maxDepth` levels), a
release or realization by its Work, and a Work, position, release or realization by
the continuities its Work belongs to. Containment goes one way. The pattern also
scores specificity: constrained dimensions first, then exact coordinates before
inherited ones.

A Statement written on a projection is stored on its subject with the frame's
coordinates as applicability (`statement/projection.ts`). Every Statement write checks
that its applicability names existing Resources with a frame dimension, and on a
projection refuses a caller coordinate in a slot the frame already fills unless it is
that coordinate (`statement_applicability_*`).

## Disclosure and summary

A projection is readable when its subject and every frame are, and it is public only
when all are: `media/summary.ts` computes that from the parts, so it stores no
disclosure of its own. The summary's `parts` carry the subject and each frame as
summaries and its name is the subject's; the server joins no labels.

## Cost contract

See `PROJECTION_COST`. A request reads one subject summary and one target batch of at
most eight frames; an existing projection is then one indexed admission probe, one
indexed identity lookup and one summary read. A first creation adds one admission (register, claim, seal), one insert
and one guarded graph command. A list page scans at most 20 identities by keyset on
`(subject, projection)` and hydrates at most 20 × 9 parts in three summary pages.
None grows with the ratings, Statements or projections that exist elsewhere.

A frame read (`FRAME_READ_COST`) is one target batch, a keyset-batched scan of the frame's
Work's in-continuity memberships that skips hidden and unrevealed ones before counting
(at most 64 visible, 8 batches of 64) and, for a position, one query per Structure level
above it. A framed page orders by specificity, which costs what its subject holds
(`SUBJECT_STATEMENT_COST`).
