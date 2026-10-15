---
name: local-development
description: Start or refresh local REZICS stacks, prepare signed-in browser fixtures, acquire optional datasets, or perform launch accessibility checks. Load the matching procedure; ordinary code and document edits do not need a stack.
---

# Local development

Use Task commands and the task's authorized environment. A Goal worker's check
scope and recorded jobs remain in the [worker execution skill](../goal-worker/SKILL.md).

| Task | Read when needed |
| --- | --- |
| Start, refresh, stop or reset a local stack | [Local stack](references/local-stack.md). Reset only the authorized target. |
| Prepare signed-in browser sessions | [Local authorization fixture](references/local-web-auth.md). |
| Capture or import the optional real catalogue corpus | [Datasets](references/local-datasets.md). Ordinary development does not acquire it. |
| Validate launch accessibility on phones and assistive technology | [Accessibility](references/launch-accessibility.md). |

Find live addresses with `task urls` and masked configuration with `task env`.
The [toolchain](../../../docs/development/toolchain.md) owns pins; the procedures
own commands and phase-specific evidence. Read one mode rather than all references.
