# Goal definitions

A tracked Goal brief defines a bounded product outcome. Product documents own behaviour; the brief links them.
[Development workflow](../development/README.md) owns the method.

The active definitions are:

- [Accounts and platform gates](accounts.md)
- [Semantic catalogue and Zones](semantic.md)
- [Search and composition](search.md)
- [Content and communities](content.md)
- [Commerce and personal library](commerce.md)
- [Imports](imports.md)
- [Web and Auth interfaces](web.md)
- [Performance](performance.md)

The completed kernel foundation is described by its [module contract](../../services/kernel/README.md), not a second
active Goal. Catalogue work is included in semantic. Interoperability has no separate active definition until its
scope is reconciled; current scope remains in the product owners and [public scope](../scope.md).

Use capability names for filenames. Keep live task identifiers, account selections, attempts, branches and process
state in local controller state.

Each brief contains:

## Outcome

State what a person or API consumer can do when the Goal is complete.

## Done when

List observable outcomes and their acceptance evidence. Include applicable disclosure, lifecycle, cost, interface
and operational outcomes. Completion requires the scoped changes on main with recorded checks covering the promoted
commit.

## Scope

State what is included, excluded or explicitly deferred. Link the current public scope.

## Ownership

Name owned paths and product documents. Identify shared contracts and their owners.

## Dependencies

Name required capabilities and accepted interfaces. Do not encode temporary task identifiers.

## Acceptance

Link outcome suites, growth checks and interface review requirements. Give the applicable commands or their owning
runbook.

## External conditions

List conditions outside repository implementation without credentials, contacts or provisioning tasks.

Estimate a large Goal and identify a smaller viable slice before starting. A scope change updates this brief and the
affected owner documents before new work is dispatched.

Local launch definitions reference this tracked file. Continuations contain operating state and links, not competing
Done when clauses or product decisions.

When a Goal finishes, retain useful scope and acceptance links; remove obsolete launch instructions and duplicated
contracts.
