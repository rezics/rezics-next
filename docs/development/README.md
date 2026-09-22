# Implementation and documentation workflow

Implement the selected Apache Jena architecture through owner contracts and the
[staged plan](../plan/README.md). Main stays Rust and calls Fuseki through HTTP;
TDB2 and jena-text/Lucene share one JVM. Account/Access retain PostgreSQL. Use a
shared typed model IR, generated OpenAPI clients and explicit service interfaces.
Keep generation reproducible and generated outputs separate from authored definitions.

The [repository organization](repository-structure.md) maps executable owners,
workspaces and generated artifacts. The [graph quickstart](../operations/installation.md)
is the first independently usable infrastructure recipe, not a complete backend.
[Web organization](web-features.md) and [component review](storybook.md) specify
frontend boundaries for subsequent implementation.

Documentation integrity tooling uses Python 3.10+ and only the standard library.
Run it from the repository root during the verification phase:

```sh
python -B -m unittest discover -s scripts/documentation -p 'test_*.py'
python -B scripts/documentation/check_docs.py
```

These checks cover local links, fragments and reachability from the design entry; they do not start or
qualify Fuseki, PostgreSQL, Main or the frontend. Compiler derivative-integrity
tests stay with the implemented compiler owner. External URLs, full Markdown
rendering and semantic ownership are reviewed separately. The checker supports
ATX headings, explicit HTML anchors, inline links and reference definitions. Follow
[execution phases](../plan/execution-workflow.md) for checks and commits. The
current documentation task does not activate servers, performance experiments
or runtime implementation. Its shell/SPARQL/assembler examples remain recipes
until the implementation phase explicitly executes their acceptance.

Temporary outputs belong to task-owned ignored storage; maintained documents
never depend on discussion attachments. Create runtime directories/packages with
their first consumer, rather than treating an empty scaffold as delivered behavior.
