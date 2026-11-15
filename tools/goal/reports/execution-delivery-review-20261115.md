# Execution delivery review: 2026-11-15

The first-public timebox was missed. Source was integrated, but implementation, acceptance and verification-tool
repair remained coupled in execution assignments. This record supports changes to existing owners; it is not an
instruction source or a claim that delivery has improved.

## Evidence and limits

- The [selected campaign audit](../../../.temp/goal/reports/unit-mode-token-audit-2026-11-15.zh-Hant.md), sections
  1, 3 and 8, covers approximately 13 hours 53 minutes. It records 108 registered command starts, 107 terminal
  results and 87 nonzero exits; all 21 browser-host commands exited nonzero. Those are command outcomes, not 87
  product assertion failures or non-overlapping hours lost. The independent editor is outside that campaign total.
- The [extraction summary](../../../.temp/goal/analysis/unit-mode-extraction-summary.json) reconciles the campaign
  accounting. The audit reports that the original Rating Goal completed before its unit received another Goal;
  an active unit does not imply that none of its assignments finished.
- The [selected editor transcript evidence](../../../.temp/execution-review-20261115/evidence.json) records source
  integrated into dev at 07:36 UTC+8, pending snapshot preparation at 11:29 and 11:44, and API, editor-package and
  seven Web author-flow checks started by 11:58. Check-runner regression submissions appear at 14:14, 15:18,
  16:12 and 16:54. These timestamps establish continued verification and tooling work in the same assignment;
  they do not establish that every run was unnecessary. The final pause is at 17:30.
- Before this correction, `delivery.md` required immediate manual source integration, while the workflow skill
  assigned integration to the controller. Agent conduct required changed-file tests and the continuation template
  required checks to pass. Commit `54384b0b627` had already strengthened unit source-integration instructions.
  Thus missing prose about manual merging alone cannot explain the continuing delay.
- The campaign audit records Sol/high for the selected native campaign sessions. The editor transcript records
  Sol/max. The active local routing file also differed from tracked routing. Neither max effort nor document size
  alone has a measured causal attribution to the missed delivery.

Raw logs and private configuration remain local and are not copied into Git. Evidence links above require the
retained operating files; their absence in a fresh checkout must remain explicit.

## Cause and correction

| Finding | Interpretation | Adopted correction and owner |
| --- | --- | --- |
| Source integration was followed by extended acceptance and check-tool repair in the same editor assignment. | Assignment boundaries allowed source delivery to turn into an expanding verification job. The exact delay attributable to this is unknown. | [Delivery phase ownership](../../../docs/development/delivery.md#implementation-and-acceptance): allocate implementation, acceptance and infrastructure repairs separately; preserve the product Goal's acceptance. |
| Repeated commands failed, including preparation before user assertions. | More executions did not reliably produce the evidence needed for delivery decisions. Individual failures may still have justified repairs. | [Check selection](../../../docs/development/verification.md#check-selection-and-failures) and [manager scheduling](../../../docs/development/supermanager.md#scheduling-and-progress): stop unchanged resubmissions after recurrence; choose narrower evidence, deferral or an owner repair. |
| Templates and skill procedures retained conflicting integration and unconditional check requirements. | Agents had competing instructions to reconcile. Whether each conflicting fragment was loaded in each incident session is not established. | Replace obsolete wording in agent conduct, the workflow skill and active role/continuation templates; link the existing owners. |
| The earlier audit emphasized accounting and excluded editor history. | It quantified cost but did not by itself explain the editor delay or identify the sustaining scheduling decisions. | [Incident method](../../../docs/development/efficiency.md#incident-method): connect evidence to the repeated decision, what stops, the owner and a comparable next outcome. |

Standing max requirements and max routing defaults were removed in the preceding correction. Explicit task-specific
effort choices remain supported. This does not retroactively alter native session settings or demonstrate savings.

## Next observation

No paused Goal is resumed for this review. After an authorized delivery resumes, compare a bounded outcome with
the incident evidence: time to integrated source and accepted behavior, repeated setup failures, manager/helper cost,
and whether each deferred check has an owner. Verify that implementation ends at its assigned handoff rather than
absorbing unrelated verification repairs. Preserve unknown attribution; no matched outcome has yet demonstrated an
efficiency gain. Use the existing checkpoint, without another watcher or recurring audit.

## Instruction-chain cleanup

The follow-up traced `renderUnitOpening`, `renderWorkerPrompt`, their role and condition templates, the Goal index
and the selected local settings. It found obsolete domain-manager references, a proof render containing both a
commit instruction and a read-only prohibition, an asynchronous wrapper render with a foreground wait instruction,
and source-only guidance still asking for acceptance-test authoring. Native unit opening also derived a document
filename from the natural-language Goal objective supplied by `native-unit-command.ts`; owner links now come from
the assigned brief instead. Renderer cases cover these phase boundaries.

Local notes contained a standing max-effort instruction, expired experiment checkpoints, duplicate recurring reviews
and future commands to restore providers or premerge checks. They were reduced to operating facts, with the original
configuration retained privately. Routing, allowances, pause controls and registered Goal/brief identities were
preserved. Closed routing experiments are inactive records, so they were not deleted. Paused adopted Goals still
need explicit phase allocation when execution is authorized again; this cleanup does not rewrite their scope or
claim to have refreshed an existing native session's context.
