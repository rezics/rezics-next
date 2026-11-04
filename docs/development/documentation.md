# Instructions and documentation

This document owns how agent instructions are organized and how documents stay small and authoritative. Agents act on
what they receive at session start, so every instruction has one authority and every layer has a size budget.
Long, append-only documents dilute the current rules.

## Instruction layers

| Layer | Holds | Single authority | Delivered | Budget as received |
| --- | --- | --- | --- | --- |
| Global | Precedence, language, one authority, legacy, temporary files, IDs, where each role's text lives | `AGENTS.md` | Loaded natively by Codex, Claude Code and Cursor | 3,000 bytes |
| Role | How a worker, manager, researcher or supermanager works | `tools/goal/prompts/<role>.md` | Rendered by the control plane; for the supermanager, by a session-start hook | worker 3,500; manager 5,000; researcher 2,500; supermanager 8,000 |
| Condition | Text for one mode: retry, rebase, proof run, shared workspace, deferred checks | `tools/goal/prompts/conditions/<id>.md` | Added by the control plane when the condition holds | 1,500 in total |
| Goal | Outcome, Done when, scope, ownership, links to adopted decisions | `docs/goals/<goal>.md` | Manager opening | 12,000 |
| Goal state | Live tasks, open decisions, next actions; no rules | The manager's continuation, with fixed headings | Manager opening and renewal | 8,000 |
| Task | Outcome, paths, acceptance, decisions made for this task, owner sections | The brief | Worker prompt | 12,288 |
| Reference | Owner documents, module READMEs, runbooks, skill stages | Tracked files | Read on demand, by section | [Budgets](#budgets) |
| Memory | Local facts: accounts, allowances, hosts, credential locations, people, machine quirks | The supermanager's memory directory | Index loaded natively | Index 12,000; total 60,000 |

Session-start totals: worker 20,000 bytes, manager 30,000, researcher 15,000, supermanager 30,000. Budgets bound
what loads at session start. An agent may read further when its question needs it; nothing mandates a whole-file read
of a reference.

Until the role templates exist, [agent conduct](agent-conduct.md) is the role text for every role.

### Rules

- **One authority per instruction.** Other layers link it; they never restate it. Numbers such as limits and caps live
  in `tools/goal/defaults.json` and fill the templates and documentation tables.
- **No silent overrides.** The control plane resolves conflicts before dispatch, so no rendered prompt holds two
  contradictory instructions. Which checks run, where, and whether they are required or deferred is a typed check plan
  in the task. A condition fragment cannot override the brief.
- **No history in instructions.** A manager's local working file is not an instruction layer. Durable decisions go
  to owner documents, Done when goes to the Goal definition, and live state goes to the continuation. When a rule
  changes, rewrite it and delete the old text; Git keeps history.
- **Prose becomes a check.** When the input, the violation and the recovery can be stated without judgment, the rule
  becomes a check at the boundary nearest the effect: dispatch, launch or landing. The prose is then deleted.
  A hook gives early feedback, but it cannot be the only enforcement, because other engines bypass it.
- **Visible rollout.** A long-lived process reports the configuration and prompt revision it runs. Writing a file
  does not prove a change is live.

### Measuring instruction changes

Every attempt records a prompt manifest: each layer's source path, hash and rendered size, plus the model, effort
and tier. Prompt sources are versioned in Git and tested on their rendered output. Each week, compare bundles on
comparable work:

- accepted attempts per attempt;
- landed product lines per allowance;
- questions whose answer was in the supplied context;
- policy failures: stale authority, a conflicting check plan, a lost requirement, or false completion.

Roll a template back when the accepted-attempt rate falls by more than 5 points, or landed lines per allowance fall by
more than 10%.

## Documents

### Owner documents

Owner documents are authoritative, tracked and budgeted:

- `AGENTS.md`;
- `docs/architecture.md` and `docs/scope.md`;
- product owner documents `docs/<capability>.md`;
- Goal definitions `docs/goals/<goal>.md`;
- development workflow documents in this directory;
- role prompts under `tools/goal/prompts/`;
- the control-plane runbook `tools/goal/README.md`;
- module READMEs, which hold current contracts and cost bounds;
- the workflow skill, which holds procedures that link the rules.

Research reports, `tools/goal/reports/`, `.temp/` and memory are not owners.

Owner documents state current rules and contracts only. They hold no dated headings, history or superseded
sections, no receipts of past attempts, no task IDs and no `.temp/` paths. A brief cites owner documents as authority.
It may link research only as background.

### Research

[Agent conduct](agent-conduct.md#research) says when research is commissioned.

- **Records.** Each report is `docs/research/<topic>-<researcher>.md`. The report stays unchanged: a valuable report
  is kept exactly as written, and nothing loads it by default. Its state lives in `docs/research/registry.json`:
  path, topic, researcher, state (`open`, `adopted` or `rejected`) and the owner section that records the decision.
- **Adoption.** The owner records the decision in the owner document and links the reports, in one change.
- **Deletion.** A rejected or superseded report, or one with no lasting value, is deleted in the change that decides
  it. Never delete by file-name suffix. For the existing `-current`, `-deep` and `-independent` families, the topic
  owner compares the findings, keeps every report that holds independent evidence, and deletes the rest.
- **Living specifications.** A report that briefs use as a specification is converted: its decisions move into the
  owner document, and briefs link that document.
- **Size.** A new report is at most 100,000 bytes. Bulk data goes in structured files beside it, not in prose tables.
  Existing reports keep their size.

### Task notes and state

Continuations, manager working files, decision drafts and daily audits are state. They stay under `.temp/`, which is
never tracked, or on an archive branch. Workers are never told to read main-checkout `.temp/goal/` files. A decision a
worker needs is in an owner document, or quoted in the brief within its budget.

### Budgets

Budgets are bytes. A file or directory already over its cap is recorded in the baseline. It may not grow, and
shrinking it lowers the baseline. Raising a baseline requires a `Budget-Raise:` commit trailer giving the reason.

| Path | Per file | Per directory |
| --- | ---: | ---: |
| `AGENTS.md` | 3,000 | |
| `docs/development/*.md` | 16,000 | 120,000 |
| `docs/goals/<goal>.md` | 12,000 | |
| `docs/goals/*.capabilities.*` | 40,000 | 300,000 |
| `docs/*.md` product owners | 40,000 | |
| Module `README.md` and its contract leaves | 40,000 | |
| `tools/goal/README.md` | 80,000 | |
| `tools/goal/prompts/**` | Role budgets above | 30,000 |
| New `docs/research/*.md` | 100,000 | |
| `.agents/skills/**` | `SKILL.md` 5,000; references 6,000 | 30,000 |
| Tracked `.temp/**` | 0 | 0 |

### The documentation check

`bun scripts/docs-check.ts [--changed <base>]` runs at landing for every change that touches `**/*.md`,
`tools/goal/prompts/**` or `tools/goal/defaults.json`, and it finishes in about two seconds. It enforces:

- the caps and the baseline;
- a valid research registry;
- owner-document hygiene: no dated headings, task IDs or `.temp/` paths;
- relative links that resolve, including links into a deleted file;
- generated blocks that equal their render;
- no tracked `.temp/` files.

The same module checks briefs at dispatch:

- at most 12,288 bytes;
- no reads of `.temp/goal/` or of absolute main-checkout paths;
- no research cited as authority.

### Supermanager memory

Memory holds local facts and pointers to owner documents. Rules and decisions live in the repository. The index is
at most 12,000 bytes, and the standing asks list only asks that are still open.

## Research behind this decision

- [GPT-6 Astra report](../research/prompt-and-docs-architecture-gpt-6-astra.md)
- [Claude Opus 5.5 report](../research/prompt-and-docs-architecture-opus-5-5.md)
