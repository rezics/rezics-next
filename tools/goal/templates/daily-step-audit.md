---
goal: daily-step-audit
manager: supermanager
kind: research
paths: [tools/goal/reports/**]
riskAreas: []
acceptance:
  command: [bun, tools/goal/src/cli.ts, report, --flow, --json]
  tests: ["tools/goal/src/flow.test.ts"]
  failing: false
estimate: { lines: 100, files: 1 }
criticalPath: false
waiting: []
---

Audit the control-plane delivery path for the previous UTC day. For every pipeline step from dispatch through
promotion, state what failure the step prevents, how often it caught one in the last day, the time and allowance it
cost, and whether to keep, move, merge, or remove it. Use durable telemetry only; label unrecorded counts and costs
unknown instead of estimating them. Include the previous day's `goal report --flow --since <UTC timestamp> --json`.
Recommend one structural change and define the measure that will show whether it helped. Save a concise report in
`tools/goal/reports/`.
