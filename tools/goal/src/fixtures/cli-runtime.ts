import { appendFileSync, existsSync } from 'node:fs';
import { run } from '../cli.ts';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { StdioAppServer } from '../app-server.ts';
import type { IntegrationRuntime } from '../integration-cli.ts';

export function createIntegrationRuntime(): IntegrationRuntime {
  const stateDirectory = process.env.FAKE_GOAL_STATE!;
  const mainCheckout = process.env.FAKE_GOAL_MAIN!;
  let hostEnvironmentRecorded = false;
  return {
    db: openDb(join(stateDirectory, process.env.FAKE_GOAL_DATABASE ?? 'state.sqlite')),
    mainCheckout,
    stateDirectory,
    worktreeRoot: join(stateDirectory, 'trees'),
    managerSocket: join(stateDirectory, 'manager.sock'),
    hostSweepIntervalMs: Number(process.env.FAKE_GOAL_HOST_SWEEP_MS ?? 60_000),
    codeIsCurrent: () => {
      const capture = process.env.FAKE_GOAL_HOST_ENV_CAPTURE;
      if (capture && !hostEnvironmentRecorded) {
        appendFileSync(capture, `${JSON.stringify({ pid: process.pid, env: process.env })}\n`);
        hostEnvironmentRecorded = true;
      }
      const restartWhenPresent = process.env.FAKE_GOAL_REEXEC_FLAG;
      return !restartWhenPresent || !existsSync(restartWhenPresent);
    },
    supermanager: 'supermanager',
    hostCommand: [process.execPath, import.meta.filename],
    fence: {
      assertCurrent() {},
      commitMerge(_ref, merge) {
        return merge();
      },
    },
    sink: { onGateOutcome() {} },
    landing(task) {
      return { taskId: task, attempt: 1, branch: task, worktree: '', declaredPaths: ['**'], gate: ['true'] };
    },
    manager(goal, engine, budget) {
      return {
        id: goal,
        goal,
        engine,
        budget,
        objective: 'Test the runtime',
        brief: 'Wait for instructions',
        cwd: mainCheckout,
        pool: { id: 'fake', codexHome: join(stateDirectory, 'codex') },
        effort: 'low',
        supermanager: 'supervisor',
        limits: { turns: 100, turnsWithoutDecision: 100, wallMs: 3_600_000 },
      };
    },
    managerServices: {
      command: [process.execPath, import.meta.filename],
      connect: async () => {
        const client = new StdioAppServer(
          [process.execPath, join(import.meta.dir, 'fake-app-server.ts')],
          { ...process.env, FAKE_RPC_LOG: join(stateDirectory, 'rpc.jsonl') },
          Number(process.env.FAKE_RPC_TIMEOUT_MS ?? 30_000),
        );
        await client.initialize();
        return client;
      },
      windows: { register: () => '@1', unregister() {} },
      checkCompletion: async () => ({
        passed: false,
        evidencePath: join(stateDirectory, 'completion.log'),
        summary: 'Unmerged tasks',
      }),
    },
  };
}

if (import.meta.main) process.exit(await run(Bun.argv.slice(2), createIntegrationRuntime));
