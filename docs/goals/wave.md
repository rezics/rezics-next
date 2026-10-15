# Waves: build, then prove

A wave puts implementation and full-stack verification in separate phases.
Every task in the build phase commits to one shared branch, `wave/<n>`, and
starts no stack. The prove phase then runs the whole suite on that branch at
a pace the host can carry and fixes what fails. The branch reaches `main` once,
through the ordinary gate.

Batch verification reduces repeated stack startup and contention.

## A build task

Load the [wave execution skill](../../.agents/skills/goal-wave/SKILL.md#a-build-task)
for build steps. The brief selects the branch and any recording exception;
ordinary build tasks start no QA stack. A build handoff alone proves no persona
cell and does not land the task separately.

## The prove phase

Use the [prove procedure](../../.agents/skills/goal-wave/SKILL.md#the-prove-phase)
for generation, pinned suite runs, repairs and wave landing. Do not run a prove
campaign while build tasks still need its heavy-check admission.
