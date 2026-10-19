import { ensureDependencies } from './dependencies.ts';
// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, gate lanes, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { typecheckWorkspaces, TYPECHECK_WORKSPACES } from '../qa/affected.ts';
import { startGoal, closeGoal, newBrief, tidy, dispatch, waitFor, resumeTask, stopTask, landTask, setAutoLand, lendFiles, closeTasks, reclaimTask } from './tasks.ts';
import { describe, taskOf } from './launch.ts';
import { readLedger, areasOf, activeGoals, unlandedChangers, sameClaimBase, stateDir, withLedger, root } from './ledger.ts';
import { mergeTask } from './merge.ts';
import { pathsOverlap, isGeneratedOutput, validGoalSlug, isHeavyTest } from './briefs.ts';
import { engineNames } from './types.ts';
import { loadSettings } from './config.ts';
import { status } from './status.ts';
import { eventStateDirectory, mailCommand, eventLedger, coordinatorCommand } from './manager-commands.ts';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { provideGoalctl, runRegression, parseRegressArgs, regressionTimingReport, appendInbox, inboxEntries } from './regress.ts';
import { declaredTestTimeout, planUnitGateShards } from './unit-gate.ts';
import { heavyQaStatus, qaSlotCount, withSlot, withRecovery } from './qa-slots.ts';
import { withTestAdmission } from './admission.ts';
import { usageReport } from './usage.ts';
import { goalMeasures } from './measures.ts';
import { prepareCheckTree, warnHarnessCurrency } from './tree-currency.ts';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { landsOutsideTurn, startLandingOutsideTurn, reportLanding } from './land-outside-turn.ts';

export { type State, type Engine, BRIEF_KINDS, type BriefKind, type Brief, type Attempt, type Task, type GoalRecord, type Ledger, type UsageWindow, type UsageSnapshot, type UsageSample, type UsageLevel, type UsageReport, type AccountUsage, type CodexResetStatus, type CodexResetLoad, MODEL, FABLE_MODEL, SONNET_MODEL, HAIKU_MODEL, CODEX_MODEL, LUNA_MODEL, GROK_MODEL, DEFAULT_ENGINE } from './types.ts';
export { parseFrontmatter, parseBrief, validateBrief, mechanismSectionErrors, rangesOverlap, pathsOverlap, isGeneratedOutput, claimConflicts, outOfScope, GOALS_DIR, validGoalSlug, goalFile, goalBriefFile, goalOfBriefPath, goalAreas, areaConflicts, nextTaskId, HISTORY_EXEMPT, type ChangedFile, historyIntroductions, ownerRefusal, isHeavyTest } from './briefs.ts';
export { PROJECTED_LIMIT, CRITICAL_USED, WEEK_CAP, WEEK_TARGET, WEEK_PROJECTED_LIMIT, WEEK_CRITICAL_USED, burnRate, weekBurnRate, usageLevel, parseCodexUsage, loadCodexResetStatus, codexHoursUntil100, type GoalUsageReport, usageReport } from './usage.ts';
export { launchCommand, SOL_CONTEXT_WINDOW, CODEX_TOOL_OUTPUT_TOKENS, briefFile, memoryFloorRefusal, managerWakeGates, workerSessionEnvironment, capacityRefusal } from './launch.ts';
export { retryGitIndexLock, ARCHIVE_BRANCH, archiveFiles, removeFromTree, treeMentions, landClaimScope, REGENERATION_COMMIT_SUBJECT, regenerationOnlyFiles } from './ledger.ts';
export { dispatchMethodErrors, waitFor, resumeDecisionError, killWorktreeProcesses, removeWorktreeStack, preserveWorktreeArtifacts, COMPOSITION_ROOTS } from './tasks.ts';
export { normalizeUseChains, compositionSyntaxFailure, type CompositionMerge, prepareCompositionMerge, migrationsBelowMain, landedBoundary } from './merge-normalise.ts';
export { type DeclaredTestTimeout, declaredTestTimeout, UNIT_GATE_TIMEOUT_MARGIN_MS, type PlannedUnitShard, UNIT_GATE_FILE_CAP, planUnitGateShards, readMeasuredUnitDurations, mergeUnitFiles, mergeOwnerFiles, unitFilesFromPlan, ownerFilesFromPlan, UNIT_JUNIT_MARKER, failingTestFiles, balanceUnitShards, type UnitShardResult, type UnitShardRunner, timedOutTestFiles, shardTimeoutFiles, type UnitFailureDetail, type UnitFileErrorDetail, type UnitRunnerError, unitFailureDetails, normalizeUnitFileError, unitFileErrorDetails, type UnitGateRunKind, type UnitFailureCase, type UnitFileEvidence, type UnitRunEvidence, type UnitGatePass, unitFileEvidence, unitGateRefusal, writeUnitEvidence, type IntroducedUnitFailure, introducedUnitFailures, introducedUnitFailureFiles, runOwnerShard, type UnitGateOptions, runUnitGate, streamUnitBaseline, streamSelectionFiles, runUnitSide, type InfrastructureStep, infrastructureStep, type BranchOnlyClassification, classifyBranchOnlyFailures, branchOnlyRefusal, gateTreeRefusal } from './unit-gate.ts';
export { typecheckDiagnostics, unclassifiedTypecheckLines, introducedTypecheckDiagnostics, type TypecheckRun, type TypecheckSide, typecheckGate, addGateWorktree, dependencyInstallIsStale, missingPinnedImage } from './typecheck-gate.ts';
export { type PreparedMerge, type MainSync, type FastForward, type FastForwardGates, fastForwardMain, typeRechecksSpent } from './merge.ts';
export { reapStaleQaStacks, heavyQaStatus, heavyQaWaiters, sharedLifecycleStatus, sharedLifecycleWaiters, type QaWaitStatus, qaWaitStatusLines, qaSlotCount, gateLaneStatus, gateLaneWaiters, type GateLaneOptions, withGateLane, type HeavyWaitOptions, acquireHeavy, type SharedLifecycleWaitOptions, acquireSharedLifecycle, type SlotRunOptions, markHeavyCommandStarted, markSharedLifecycleCommandStarted, sharedLifecycleEnvironment, inheritedSharedLifecycleOwnership, transferSharedLifecycleOwnership, withRecovery, withSlot } from './qa-slots.ts';
export { mailCommand, managerEvents, coordinatorEnrollmentOptions, coordinatorStartOptions, coordinatorStartDescriptor } from './manager-commands.ts';

export { typecheckWorkspaces, TYPECHECK_WORKSPACES };

const GOAL_COMMANDS_DIRECTORY = join(import.meta.dir, 'commands');
const GOAL_COMMAND_NAME = /^[a-z]+(?:-[a-z]+)*$/u;

async function goalCommandFiles(): Promise<string[]> {
  try {
    return (await readdir(GOAL_COMMANDS_DIRECTORY, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^[a-z]+(?:-[a-z]+)*\.ts$/u.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function loadGoalCommand(fileName: string) {
  return import(pathToFileURL(join(GOAL_COMMANDS_DIRECTORY, fileName)).href) as Promise<{
    usage: string;
    default(args: string[]): number | Promise<number>;
  }>;
}

async function main(argv: string[]): Promise<number> {
  if (resolve(process.cwd()) === resolve(root)) ensureDependencies(root);
  loadSettings();
  (await import('./coordinator.ts')).recordTurnCommand(argv);
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  switch (command) {
    case 'config': {
      const { settings, sources } = loadSettings();
      console.log(JSON.stringify({ settings, sources }, null, 2));
      return 0;
    }
    case 'init':
      throw new Error('init is replaced by `goal start <slug> --manager <session>`; see docs/goals/README.md');
    case 'goal': {
      const [action, slug = ''] = positional;
      if (action === 'start') { await startGoal(slug, rest.slice(2)); return 0; }
      if (action === 'close') return closeGoal(slug, flags);
      throw new Error('goal needs start <slug> --manager <session> [--adopt] [--allow-area] | close <slug> [--dry-run]');
    }
    case 'new': await newBrief(rest); return 0;
    case 'tidy': await tidy(rest); return 0;
    case 'dispatch': {
      const index = rest.indexOf('--engine');
      if (index >= 0 && (!rest[index + 1] || rest[index + 1]!.startsWith('--'))) throw new Error('--engine needs an account or model engine');
      const source = rest.find((arg, at) => !arg.startsWith('--') && (index < 0 || at !== index + 1));
      await dispatch(source ?? '', flags, index >= 0 ? rest[index + 1] : undefined);
      return 0;
    }
    case 'wait': await waitFor(positional[0] ?? ''); return 0;
    case 'resume': await resumeTask(rest[0] ?? '', rest.slice(1)); return 0;
    case 'stop': await stopTask(positional[0] ?? ''); return 0;
    case 'scope':
      if (positional.length) console.log(describe(taskOf(readLedger(), positional[0]!)));
      else return (await loadGoalCommand('scope.ts')).default(rest);
      return 0;
    case 'merge': await mergeTask(positional[0] ?? '', flags); return 0;
    case 'gate': await mergeTask(positional[0] ?? '', flags, undefined, undefined, undefined, true); return 0;
    case 'land': {
      const id = positional[0] ?? '';
      const step = flags.has('--step');
      const task = taskOf(readLedger(), id);
      const runDir = join(stateDir, 'runs', task.id);
      if (landsOutsideTurn(process.env)) {
        console.log(startLandingOutsideTurn({ id: task.id, step, runDir, root, script: import.meta.filename, env: process.env }));
        return 0;
      }
      if (!flags.has('--report')) { await landTask(id, step); return 0; }
      return reportLanding(task.id, step, () => landTask(id, step), (body, key) => {
        const file = join(runDir, 'land-report.txt');
        writeFileSync(file, `${body}\n`);
        const directory = eventStateDirectory();
        mailCommand(['send', task.goal ?? '', '--file', file, '--key', key],
          { stateDir: directory, goals: Object.keys(eventLedger(directory).goals ?? {}), callerGoal: process.env.GOAL_ID ?? task.goal });
      });
    }
    case 'auto-land': await setAutoLand(positional[0] ?? '', positional[1] !== 'off'); return 0;
    case 'loan': await lendFiles(positional[0] ?? '', positional.slice(1)); return 0;
    case 'close': await closeTasks(positional.slice(0, -1), positional.at(-1) ?? ''); return 0;
    case 'reclaim': await reclaimTask(positional[0] ?? '', positional[1] ?? '', flags); return 0;
    case 'owner': {
      // Only a live claim on this base blocks; unlanded edits are overlaps for the merge.
      const path = positional[0] ?? '';
      const ledger = readLedger();
      const areas = Object.entries(areasOf(activeGoals(ledger)))
        .filter(([, globs]) => globs.some(glob => pathsOverlap(glob, path))).map(([slug]) => slug);
      const areaNote = areas.length ? `; in Goal ${areas.join(', ')}'s area` : '';
      if (isGeneratedOutput(path)) {
        console.log(`${path}: unclaimed${areaNote}`);
        return 0;
      }
      const tasks = Object.values(ledger.tasks);
      const holders = tasks.filter(task => task.id !== process.env.GOAL_TASK_ID
        && ['starting', 'running'].includes(task.state) && sameClaimBase(task, process.cwd())
        && task.paths.some(pattern => !isGeneratedOutput(pattern)
          && (new Bun.Glob(pattern).match(path) || pathsOverlap(pattern, path))));
      const changed = unlandedChangers(tasks, path).filter(task => task.id !== process.env.GOAL_TASK_ID
        && !holders.some(holder => holder.id === task.id));
      const claimText = holders.length
        ? `claimed by ${holders.map(task => `${task.id} (${task.state})`).join(', ')}` : '';
      const changeText = changed.length ? `overlap with ${changed.map(task => task.id).join(', ')} (unlanded; resolve at merge; proceed)` : '';
      const body = [claimText, changeText].filter(Boolean).join('; ') || 'unclaimed';
      console.log(`${path}: ${body}${areaNote}`);
      return claimText ? 1 : 0;
    }
    case 'status': await status(); return 0;
    case 'mail': {
      const directory = eventStateDirectory();
      for (const line of mailCommand(rest,{stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {}),callerGoal:process.env.GOAL_ID})) console.log(line);
      return 0;
    }
    case 'coordinator': await coordinatorCommand(rest); return 0;
    case 'regress': {
      // Worktree smoke runs can keep reports/inboxes in their writable checkout; QA still uses the shared host lock.
      const regressionState = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
      const options = parseRegressArgs(rest);
      if (options.timing) {
        console.log(regressionTimingReport(join(regressionState, 'regress', options.timing)));
        return 0;
      }
      provideGoalctl({ declaredTestTimeout, planUnitGateShards, heavyQaStatus });
      const manifest = await runRegression({ ...options, repo: process.cwd(), stateDir: regressionState,
        slots: qaSlotCount(join(stateDir, 'qa-slots')),
        route: entry => regressionState === stateDir ? withLedger(() => appendInbox(stateDir, entry))
          : Promise.resolve(appendInbox(regressionState, entry)) });
      console.log(`Regression ${manifest.runId}: ${manifest.status} at ${manifest.atCommit}`);
      console.log(`Manifest: ${join(regressionState, 'regress', manifest.runId, 'manifest.json')}`);
      return manifest.status === 'passed' ? 0 : 1;
    }
    case 'inbox': {
      const goal = process.env.GOAL_ID ?? 'program';
      if (!validGoalSlug(goal)) throw new Error('Invalid inbox Goal');
      if (rest.length && (rest.length !== 2 || rest[0] !== '--ack' || !/^\d+$/.test(rest[1]!))) {
        throw new Error('inbox accepts --ack <number> (the displayed line number)');
      }
      await withLedger(() => {
        const entries = inboxEntries(stateDir, goal, rest.length ? Number(rest[1]) : undefined);
        for (const entry of entries) console.log(JSON.stringify(entry));
        if (!entries.length) console.log(`Goal ${goal}: inbox empty`);
      });
      return 0;
    }
    case 'usage':
      console.log(JSON.stringify({ ...await usageReport(), measures: await goalMeasures(readLedger(), { root }) }, null, 2));
      return 0;
    case 'test': {
      ensureDependencies(process.cwd());
      const at = rest.indexOf('--result-file');
      const resultFile = at < 0 ? undefined : rest[at + 1];
      if (at >= 0 && (!resultFile || resultFile.startsWith('--'))) throw new Error('--result-file needs a path');
      const args = rest.filter((arg, index) => arg !== '--heavy' && (at < 0 || (index !== at && index !== at + 1)));
      warnHarnessCurrency(process.cwd());
      return withTestAdmission(['bun', 'scripts/qa/test.ts', ...args], isHeavyTest(rest), resultFile);
    }
    case 'slot': {
      ensureDependencies(process.cwd());
      warnHarnessCurrency(process.cwd());
      if (rest[0] === '--recovery') {
        const command = rest.slice(1);
        return withRecovery(command[0] === '--' ? command.slice(1) : command);
      }
      const heavy = rest[0] === '--heavy';
      const command = heavy ? rest.slice(1) : rest;
      return withSlot(command[0] === '--' ? command.slice(1) : command, heavy);
    }
    case 'check': {
      if (rest[0] === '--branch') {
        if (rest.length !== 2 || !rest[1]) throw new Error('check --branch requires one ref');
        const { branchCheck } = await import('./branch-check.ts');
        return (await branchCheck(rest[1])).code;
      }
      const { parseCheckArgs } = await import('./check.ts');
      const only = parseCheckArgs(rest);
      const prepared = process.env.GOAL_CHECK_PREPARED_TREE;
      delete process.env.GOAL_CHECK_PREPARED_TREE;
      const cwd = process.cwd();
      const ready = prepared === cwd;
      const update = ready ? undefined : prepareCheckTree(cwd);
      if (update?.failed) return 1;
      if (update && update.before !== update.after) {
        // Imports already in memory belong to the old tree. Restart from this worktree's updated files.
        return new Promise<number>(resolveExit => {
          const child = spawn(process.execPath, [join(cwd, 'scripts/goal/goalctl.ts'), ...argv], {
            cwd, stdio: 'inherit', env: { ...process.env, GOAL_CHECK_PREPARED_TREE: cwd },
          });
          child.once('error', error => { console.error(error.message); resolveExit(1); });
          child.once('close', code => resolveExit(code ?? 1));
        });
      }
      const { workerCheck } = await import('./check.ts');
      return (await workerCheck({ only, treePrepared: true })).code;
    }
    default: {
      const commandFiles = await goalCommandFiles();
      if (typeof command === 'string' && GOAL_COMMAND_NAME.test(command) && commandFiles.includes(`${command}.ts`)) {
        const commandModule = await loadGoalCommand(`${command}.ts`);
        return commandModule.default(rest);
      }
      console.error('Usage: goalctl goal start <slug> --manager <session> [--adopt] [--allow-area] | goal close <slug> [--dry-run]'
        + ' | new [--goal <slug>] <title> | dispatch <G-id|brief.md> [--engine <engine>] [--dry-run] [--force-usage] [--allow-area]'
        + ' | wait <id> | owner <path> | reclaim <id> <brief> [--allow-area] | resume <id> (-m <text> | --file <path>) [--effort e] [--class baselineRed|environment|fixRound|sameScope]'
        + ` [--engine ${engineNames().join('|')}] [--fresh] [--force-usage]`
        + ' | stop <id> | scope <id> | land <id> | merge <id> [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate] [--skip-type-gate]'
        + ' | gate <id> [--skip-unit-gate] [--skip-type-gate]'
        + ' | close <id>... verified|cancelled | tidy [--legacy <archive directory>]'
        + ' | status | usage | regress [--at <rev>] [--resume <run-id>] [--only <tiers>] [--integration-batches <n>]'
        + ' | mail send <goal> --file <path> --key <key> [--deadline <minutes>] | mail inbox [goal] [--all] | mail ack <id> [--goal <goal>]'
        + ' | config | coordinator [start <goal> --engine <engine> --effort <effort> [--model <id>]|enroll <goal> --session <UUID> --engine <engine> --effort <effort> --cwd <dir> --previous-owner-pid <pid> [--model <id>] [--tmux-socket <path>]|status|unenroll <goal>]'
        + ' | inbox [--ack <n>] | test [--heavy] <task test args> | slot [--heavy|--recovery] -- <command>');
      for (const fileName of commandFiles) {
        const commandModule = await loadGoalCommand(fileName);
        console.error(commandModule.usage);
      }
      return 2;
    }
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
