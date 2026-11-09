---
goal: daily-step-audit
manager: supermanager
kind: research
paths: [tools/goal/reports/daily-step-audit-*.md]
riskAreas: []
acceptance:
  failing: false
estimate: { lines: 100, files: 1 }
criticalPath: false
waiting: []
---

Audit the control-plane delivery path for the previous UTC day. For every pipeline step from dispatch through
promotion, state what failure the step prevents, how often it caught one in the last day, the time and allowance it
cost, and whether to keep, move, merge, or remove it. Use durable telemetry only; label unrecorded counts and costs
unknown instead of estimating them. Read the existing `goal report --flow --since <UTC timestamp> --json` output as
evidence. Use the half-open UTC day for counts and keep any raw export in `.temp/`, outside the committed report.
Recommend one structural change and define the measure that will show whether it helped. Save a concise report in
`tools/goal/reports/daily-step-audit-<previous-UTC-day>.md`.
Check that the report's counts and window match the retained evidence. This report does not change executable code;
it does not require a test wrapper or compiler run.
