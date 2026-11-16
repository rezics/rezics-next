import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import type { Settings } from './types.ts';
import { authenticatedManager } from './priority-authority.ts';
import {
  nativeUnitEnvironment,
  readNativeGoal,
  registeredNativeUnits,
  registerNativeUnit,
  type NativeUnit,
} from './native-units.ts';
import { desktopCodexCaller, nativeUnitContext, NATIVE_UNIT_RUN_VARIABLE } from './native-unit-context.ts';
import { renderGoalAuthorOpening, renderSupermanagerOpening, renderUnitOpening } from './prompts.ts';
import { databaseStage, openReadOnlyDb } from './db.ts';

function unitCaller(db: Database, settings: Settings, unit?: NativeUnit, desktop = unit?.pane === null): void {
  const env = process.env;
  const thread = desktop ? desktopCodexCaller(env) : (env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID);
  const actor = authenticatedManager(db, {
    ...env,
    CODEX_THREAD_ID: thread,
  });
  if (actor?.id === settings.integration.supermanager) return;
  let current = thread;
  if (unit && current) {
    const native = openReadOnlyDb(join(unit.codexHome, 'state_5.sqlite'), settings.policy?.storage);
    try {
      const seen = new Set<string>();
      while (current && seen.size < 16 && !seen.has(current)) {
        if (current === unit.threadId) return;
        seen.add(current);
        const thread = databaseStage(native, 'unit caller ancestry lookup', () =>
          native.query('SELECT source FROM threads WHERE id=?').get(current),
        ) as { source: string } | null;
        try {
          current = JSON.parse(thread?.source ?? 'null')?.subagent?.thread_spawn?.parent_thread_id;
        } catch {
          current = undefined;
        }
      }
    } finally {
      native.close();
    }
  }
  throw new Error(
    unit
      ? 'Native unit context belongs to its root manager, thread or subagents'
      : 'Only the registered root manager may register native units',
  );
}

function termspacesInventory(settings: Settings): unknown {
  const observed = spawnSync(
    settings.integration.termspacesCommand,
    ['--socket-path', settings.integration.tmuxSocket, '--json', 'status'],
    { encoding: 'utf8' },
  );
  if (observed.status !== 0)
    throw new Error(`termspaces inventory unavailable: ${observed.error?.message ?? observed.stderr.trim()}`);
  try {
    return JSON.parse(observed.stdout);
  } catch {
    throw new Error('termspaces inventory is not JSON');
  }
}

export async function runNativeUnitCommand(
  args: string[],
  runtime: { db: Database; settings: Settings },
): Promise<number> {
  const [command, id, ...rest] = args;
  const { db, settings } = runtime;
  if (command === 'author-prompt' || command === 'resident-prompt') {
    if (id !== '--brief' || rest.length !== 1) throw new Error(`usage: unit ${command} --brief <assignment-file>`);
    unitCaller(db, settings);
    const brief = readFileSync(rest[0]!, 'utf8');
    console.log(
      command === 'author-prompt'
        ? renderGoalAuthorOpening({ brief, cwd: settings.mainCheckout }).prompt
        : renderSupermanagerOpening({
            spec: {
              id: settings.integration.supermanager,
              goal: 'First public delivery',
              brief,
              cwd: settings.mainCheckout,
              engine: 'codex',
            },
            backlogPath: '',
            command: 'bun tools/goal/src/cli.ts',
          }).prompt,
    );
    return 0;
  }
  if (command === 'prompt') {
    if (!id || rest.length) throw new Error('usage: unit prompt <unit>');
    const unit = registeredNativeUnits(db).find((candidate) => candidate.id === id);
    if (!unit) throw new Error(`Native unit is not registered: ${id}`);
    unitCaller(db, settings, unit);
    const { goal } = readNativeGoal(unit.codexHome, unit.threadId, unit.pane === null);
    console.log(
      renderUnitOpening({ goal: goal.objective, brief: readFileSync(unit.briefPath, 'utf8'), cwd: unit.worktree })
        .prompt,
    );
    return 0;
  }
  if (command === 'status') {
    if (rest.length) throw new Error('usage: unit status [unit]');
    const units = registeredNativeUnits(db).filter((unit) => !id || unit.id === id);
    console.log(JSON.stringify(units, null, 2));
    return 0;
  }
  if (command === 'register') {
    if (!id)
      throw new Error(
        'usage: unit register <unit> --thread <thread> (--desktop | --pane <%id>) --worktree <path> --brief <path> --pool <pool>',
      );
    const { values } = parseArgs({
      args: rest,
      options: {
        thread: { type: 'string' },
        pane: { type: 'string' },
        desktop: { type: 'boolean' },
        worktree: { type: 'string' },
        brief: { type: 'string' },
        pool: { type: 'string' },
      },
    });
    if (
      !values.thread ||
      !values.worktree ||
      !values.brief ||
      !values.pool ||
      Boolean(values.desktop) === Boolean(values.pane)
    )
      throw new Error('Native unit registration needs thread, worktree, brief, pool and either --desktop or --pane');
    const pool = settings.pools.find((candidate) => candidate.name === values.pool && candidate.cli === 'codex');
    if (!pool) throw new Error('Native units use an existing configured Codex pool');
    unitCaller(db, settings, undefined, values.desktop);
    const viewer = values.desktop
      ? { pane: null }
      : { pane: values.pane!, termspacesStatus: termspacesInventory(settings) };
    const unit = registerNativeUnit(db, {
      id,
      threadId: values.thread,
      ...viewer,
      worktree: values.worktree,
      briefPath: values.brief,
      codexHome: pool.configDirectory,
      pool: pool.name,
      mainCheckout: settings.mainCheckout,
      stateDirectory: settings.stateDirectory,
    });
    console.log(JSON.stringify(unit));
    return 0;
  }
  if (command === 'context' || command === 'run') {
    if (!id || (command === 'context' && rest.length))
      throw new Error(`usage: unit ${command} <unit>${command === 'run' ? ' [-- <acceptance argv>]' : ''}`);
    const unit = registeredNativeUnits(db).find((candidate) => candidate.id === id);
    if (!unit) throw new Error(`Native unit is not registered: ${id}`);
    unitCaller(db, settings, unit);
    const environment = nativeUnitEnvironment(unit);
    if (command === 'context') {
      console.log(JSON.stringify({ cwd: unit.worktree, environment, command: unit.acceptance.command }));
      return 0;
    }
    const requestedCommand = rest[0] === '--' ? rest.slice(1) : rest;
    const commandArgv = requestedCommand.length ? requestedCommand : unit.acceptance.command;
    const runId = randomUUID();
    db.query(
      'INSERT INTO native_unit_runs(id, unit, started_at, requested_source_commit, context, command) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      runId,
      unit.id,
      new Date().toISOString(),
      nativeUnitContext(environment)!.sourceRevision,
      environment.REZICS_NATIVE_UNIT_CONTEXT!,
      JSON.stringify(commandArgv),
    );
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(commandArgv, {
        cwd: unit.worktree,
        env: {
          ...process.env,
          GOAL_TASK_ID: undefined,
          GOAL_ATTEMPT: undefined,
          GOAL_CHECK_REGISTRY: undefined,
          ...environment,
          [NATIVE_UNIT_RUN_VARIABLE]: runId,
        },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
    } catch (error) {
      db.query('UPDATE native_unit_runs SET ended_at=? WHERE id=?').run(new Date().toISOString(), runId);
      throw error;
    }
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const forward = signals.map((signal) => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return { signal, handler };
    });
    try {
      const exitCode = await child.exited;
      db.query('UPDATE native_unit_runs SET ended_at=?, exit_code=? WHERE id=?').run(
        new Date().toISOString(),
        exitCode,
        runId,
      );
      return exitCode;
    } finally {
      for (const { signal, handler } of forward) process.off(signal, handler);
    }
  }
  throw new Error('usage: unit register|status|context|run|prompt|author-prompt|resident-prompt');
}
