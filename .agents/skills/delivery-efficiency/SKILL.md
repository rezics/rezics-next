---
name: delivery-efficiency
description: Diagnose and improve an active delivery workflow when the manager sees a missed milestone, a slipping completion forecast, or repeated costly work with little new evidence. Set rolling milestones, test bottleneck hypotheses, and verify corrective changes.
---

# Delivery efficiency

Use this skill when delivery starts to slip. Invoke it yourself as soon as the deviation can change a decision, including during a long run. Use existing progress events and checkpoints. Keep the user’s delivery objective and required acceptance as the basis for every change.

## Set the next milestone

- Choose the nearest observable result that advances the critical path or resolves the uncertainty holding it up. Examples include an integrated source slice, a reproducible failing request, and a complete accepted journey.
- Set an expected completion range and a latest useful point to see decision-changing evidence. Base both on comparable runs, dependencies, and available capacity. If data is sparse, use a provisional estimate and update it after the first useful observation. Reforecast the remaining work as evidence arrives and retain the original miss when a forecast changes.
- Track delivery and cost together. For implementation, look for useful integrated changes and actual writing time. For closeout, look for accepted journeys and cleared release blockers alongside elapsed time, queue time, and token use. Compare like work.

## Intervene when progress deviates

1. **Locate the loss.** Trace a representative attempt from its last successful step to the first missing result. Separate queueing, setup, execution, handoffs, and rework where evidence permits. Estimate which avoidable loss most delays the next accepted result. Keep uncertain attribution visible.
2. **Test a cause cheaply.** Identify the decision or repeated action sustaining the loss. Choose the smallest observation that distinguishes plausible causes and would change what you do next. Reuse applicable evidence, an existing environment, or prepared data. When a prerequisite fails, mark dependent assertions as unreached and isolate that prerequisite.
3. **Change the next action.** Apply one reversible change within your authority. Narrow the next check, reuse valid work, change the order, route a shared cause to its owner, or adjust allocation at the constrained stage. Preserve completed work and keep independent work moving. Continue an expensive approach only when its expected next result can justify the remaining cost. For recurring failures, change the relevant condition or fix the shared cause before an equivalent retry.
4. **Check the effect.** At the next comparable outcome, compare the time to decisive evidence, repeated work, and movement toward acceptance. Include the cost of the intervention. Keep a change that improves delivery with the required evidence, or revise it and test the next hypothesis. Update the milestone when the bottleneck moves.

Carry one short entry in existing operating state through handoffs. Include the expected result and decision point, the observed gap, the action and owner, and the evidence that will decide whether to keep the change. Keep the result open until observed. Put a proven, reusable correction in the owning brief, procedure, or tool.

## Example

A browser journey times out after reaching an authenticated API request that returns an error. Use the same authorized identity and compatible data to reproduce that request directly. If it still fails, route the first failing operation to the service owner and verify the fix at that boundary. If it passes, investigate the browser-specific behavior. Prove the required end-to-end journey on an applicable candidate. Compare how quickly each approach produced a usable diagnosis and whether the journey advanced.
