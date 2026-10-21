# AI agent instructions

When instructions conflict, the maintainer's current instruction wins, then the
task brief and its decisions, this file, the protocol documents, then skills and
other documents.

Use [docs/README.md](docs/README.md) to load only the documents the task needs.
[GOAL.md](GOAL.md) lists active Goals. Managers follow their
[charter](docs/goals/manager.md); workers follow their [protocol](docs/goals/worker.md).
The [method](docs/goals/method.md) defines API outcomes before implementation
and surfaces.

All manager roles are peers. On a failure, blocker or abnormal waste, investigate
the cause, compare remedies, coordinate affected owners, then execute and verify
the best correct fix without routine upward approval. Notify every active manager
when the problem is found and when it is resolved; see the
[shared problem-solving duty](docs/goals/manager.md#shared-problem-solving-duty).

Put task-created temporary files in `.temp/`. Run project commands through Task
(`task --list`; arguments after `--`); Yarn installs dependencies. Update the
[toolchain](docs/development/toolchain.md) when adding or replacing a tool.
Use `task urls` for addresses, `task env` for masked configuration and each
workspace's `.env.example` for variables.

API operations define backend behavior; the UI consumes them. Express enforceable
behavior in types, schemas, tests, lint rules, stories and comments. Documents
hold intent, decisions with reasons and operating procedures; update a practice
that no longer fits and explain why.

Write tests with behavior changes and run affected checks. Do not add a test
that only mirrors a small reversible edit. Run `task docs:check` for documentation
changes. Build test data once, keep a consistent backup and restore isolated
copies within the [preparation budget](docs/storage/workload-budgets.md#data-preparation-and-import).

Detect documentation edits during work and treat them as authoritative. Never
silently revert one; refine it only in a separate commit explaining the change.
Finish reversible, authorized work before asking for a decision.
