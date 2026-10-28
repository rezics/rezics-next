# Architecture principles

REZICS uses one graph and one generic engine across verticals. A new vertical adds definitions and presentation
configuration. Add backend capability only when the existing abstractions cannot express a required outcome.

Choose the simplest design that meets the requirement. Prefer mature engines, extensions, libraries and standards.
A custom mechanism needs evidence of the gap it fills and a comparison with the existing alternatives.

Every operation addresses a bounded neighbourhood. State its anchors, examined keys, expansion limits and indexed
cost. Bound reads, writes, authorization, validation, projections and cleanup. A response limit does not bound a scan,
sort, join, history walk or dependency fanout.

Large jobs make bounded, resumable progress. Their total work may follow their finite input; individual steps may
not discover work through unrestricted scans or recomputation.

A capability must hold wherever its abstraction appears. Inclusion in public scope means the complete architectural
capability across its surfaces, rather than one working example.

One capability has one authority. Verticals, Realms, Zones and clients consume shared contracts rather than copying
their storage, query, permission or lifecycle mechanisms. Derived indexes and views do not become another authority.

Product writes, including imports, use the ordinary API and permission model. Fix an inadequate API rather than
creating a privileged parallel write path. Test fixtures are not product write paths.

Definitions own semantic vocabulary. Product modules own generic behaviour. Presentation configures how those
capabilities appear. A value's representation does not determine its semantic meaning or authority.

## Data access

Writes are single-partition commands. A read may not join rows across partitions.

A batched key read is not a join and is admitted for reads. It uses one statement per row kind, selecting by full
keys with `(route, id) = ANY(keys)`, with no join between partitions. All of a read's batched statements run in one
`REPEATABLE READ` snapshot per database, grouped by the database that holds the partitions. Partition rows are read
the same way. A moved partition answers as it does for a single-partition read.

Statement bounds for these reads are stated per database.

First-public-scope boundaries live in [scope](scope.md). Detailed behaviour lives in the owning product document or
module README.
