---
defers: [browser, native, root]
---

Source-only delivery is authorized for this attempt. Follow [direct source integration](docs/development/delivery.md#direct-source-integration) when integration is the bottleneck. Complete and commit coherent source; defer tests, typing, builds, browser captures and worker-check commands, including test authoring for coverage. Preserve existing tests and product contracts. Do not rerun retry-manifest commands for another verdict. Report source completion with checks unverified; it claims no compiler, test, native or Goal pass.

{{task.sourceOnlyContinuation}}

Keep original check IDs, commands, results, logs, compiler grants and cleanup obligations intact. On a check wake, use its exact delivered result and repair source defects without submitting another check. Missing, unknown, failed or running evidence is never a pass; an old pass cannot prove changed source. Return waiting only for a still-running check this attempt already owns, using its bare UUID; do not poll or interrupt it. Finished checks are not waiting. Source integration and scheduled acceptance remain distinct under the linked owner policy, including money and control-plane work.
