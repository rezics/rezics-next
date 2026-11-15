# AI agent instructions

REZICS is being rewritten; this repository contains only rebuilt parts.

## Precedence

1. The maintainer's current instruction.
2. This file.
3. Documents in this repository.
4. For topics not yet converted, the accepted ADRs and specifications in
   [rezics-next-discussion](https://github.com/rezics/rezics-next-discussion).

## Language

Code, comments, documents and commits are in English. Rewrite topics from rezics-next-discussion in English; do not
machine-translate them. Omit attribution of decisions and superseded material.

## One authority per topic

When moving a topic here, replace its rezics-next-discussion page with a pointer in the same change. Never keep two authorities.

## Legacy code

The `legacy` branch (tags `legacy-final` and `legacy-main-final`) is a read-only reference.

- Do not merge it or copy it wholesale.
- Use it for behaviour reference and differential tests where meaning is unchanged.
- Port a piece only when the new contracts need it. Add tests for it, and name the source in the commit message as
  `legacy-final:<path>`.

## Working rules

- Put temporary files in `.temp/`.
- Keep task and ticket IDs out of code and documents; put them in commit messages.
- Infer the requirement behind an example; trace shared causes and affected peers without waiting for each case
  to be named. Fix the owner module and affected uses, preserving domain differences. Workers stay within assigned
  paths and hand off related findings; managers own cross-owner follow-through. Finish the requirement, not just
  the named example; avoid unrelated rewrites or audits.
- Follow [agent conduct](docs/development/agent-conduct.md): bounded reading and verification, act instead of asking,
  no receipts.
- [Delivery efficiency](docs/development/efficiency.md) sets throughput targets. Delete bad code; deletions never offset output.
- Respect instruction and document layers, owners and budgets:
  [instructions and documentation](docs/development/documentation.md).

## Communication

Hierarchy serves speed. Every agent must promptly raise problems or harmful rules with its manager or the peer concerned.

Rules, lessons and decisions go in this repository, never in agent memory.

## Failure discipline

- Fix a failure seen twice as a class in its owner module or control plane, not another script or manual cleanup.
- Each attempt owns and cleans up its processes, containers, volumes and ports when it ends.
- Older worktrees read the shared `.temp/goal` config: add no key their code rejects, and run the CLI from an old
  worktree after changing either.
- Every watcher, alarm and wake-up spends model allowance; add one only when its cost is counted.

A worker starts from its brief and reads only what the brief links. Other roles read the
[development workflow](docs/development/README.md) and its linked Goal definitions, and load
[rezics-workflow](.agents/skills/rezics-workflow/SKILL.md) for repository development work.
