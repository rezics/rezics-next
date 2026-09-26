# Relationship graph API and views

## Graph contract

Expose typed resources, identified relations, participant roles, context and exact
revision/source references. Repeated associations remain separate. Character,
credit, causal/background and package graphs share representation protocols but
retain domain-specific meaning. Reachability does not automatically prove causality,
identity equality, chronology or permission.

Use [Statements](classification.md) for independently evidenced claims and domain
relation occurrences for repeated or multi-participant associations. A node's
concept type introduces no Tag wrapper. Summary nodes share
[name/avatar resolution](presentation.md#resource-summaries); display grouping
does not create additional semantic edges.

## Queries

Require anchors or admitted selective seeds, relation/profile filters, context,
direction and traversal budgets. Return bounded node/edge pages with continuation,
frontier/completeness and match reasons. Bind participant conditions to one relation
instance. Property paths and full-text seeds can compose inside Jena; avoid
unanchored whole-graph closure or application-side N+1 traversal.

Aggregate nodes/edges only under an explicit grain and equivalence rule. Preserve
exact occurrence references when collapsing a view, and count a resource once
across several supporting statements or navigation paths. Role and trait
conditions must refer to the same participant and compatible occurrence scope.
Use the shared [aggregation response](search.md#statement-aggregation), not a
client-side concatenation of unrelated graph pages.

## Mutation and presentation

Domain commands create/revise/retire relations under expected heads and role
constraints. Imported assertions and AI-extracted candidate links retain evidence
and acceptance. Layout positions are view state, not graph truth. A graph Block
contains a declarative query/view descriptor and does not embed executable code.

Private nodes/edges, counts and hidden paths cannot be inferred from a public
frontier. Exact history follows current disclosure. Test repeated participants,
disputed causality, context-separated canon, dense hubs, cancellation and export.
