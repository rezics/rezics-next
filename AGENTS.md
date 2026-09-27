# AI agent instructions

Put task-created temporary files in `.temp/`.

Run commands through Task (`task --list`; arguments after `--`); Yarn only
installs dependencies. Tools and versions are recorded in
`docs/development/toolchain.md`; update it in the same change that adds or
replaces one. The main checkout's `task dev` serves the shared local backend
under Aspire on fixed ports; in a worktree `task dev` runs only web and Storybook
on random ports against it (`-- --backend` for an isolated backend). Find
addresses with `task urls` or Aspire's MCP server, and configuration with
`task env` and each workspace's `.env.example`.

API operations define backend behavior; UI consumes the APIs.

Express in code whatever code can express: types, schemas, tests, lint rules,
stories and comments. Write documents only for what code cannot carry, such as
intent, decisions with their reasons and operating procedures. Documents record
practice to consult, not rules; when one no longer fits, change it and explain why.

Write tests with the implementation and run the checks the change affects:
`task test -- --affected [<base>]` (`--list` previews the plan), explicit
`task test` paths, and `task docs:check` for documentation changes. Build test
data once, keep a consistent backup and restore isolated copies; routine
preparation, including restore, startup and readiness, stays under 10 minutes
(`docs/storage/workload-budgets.md#data-preparation-and-import`).

The maintainer may update any documentation at any time with any tool. Treat
those updates as authoritative: detect them, adapt, never revert them silently;
refine them only in a separate, explained commit.

When a Goal is active, `GOAL.md` states it. Its manager follows
`docs/goals/manager.md`, and its worker processes follow `docs/goals/worker.md`.
