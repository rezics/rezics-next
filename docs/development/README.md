# Implementation and documentation workflow

Implement the selected architecture through owner contracts and the staged plan.
Use a shared typed model IR, generated OpenAPI clients and explicit service
interfaces. Keep code generation reproducible and generated outputs separate
from authored definitions. [Web organization](web-features.md) and
[component review](storybook.md) specify frontend boundaries.

Documentation validation runs from the repository root:

```sh
python -B -m unittest discover -s scripts/documentation -p 'test_*.py'
python -B scripts/documentation/check_docs.py
```

These checks cover links, owners and design-role drift, not runtime qualification.
Compiler derivative-integrity tests remain with their compiler owner rather than
the design collection. Follow [execution phases](../plan/execution-workflow.md)
for executable checks and commits. Temporary outputs belong to task-owned ignored
storage; maintained documents never depend on discussion attachments.
