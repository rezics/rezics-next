import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { driveGateParity } from '../scripts/gate-parity.ts';
import { integrationHarness } from './test-support.ts';
import { git } from './merge.ts';
import { runBoundedProcess, type BoundedProcessResult } from './lifecycle-fixture.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type RegressionCase = {
  id: string;
  incident: string;
  file: string;
  testName: string;
};

export type LifecycleTestCase = {
  id: string;
  file: string;
  testName: string;
  scenarioId?: string;
};

export const REQUIRED_LIFECYCLE_SCENARIOS = [
  'real-systemd-scope-preflight',
  'dev-worker-check-start-and-result-records',
  'provider-real-cli-launch-wait-wake',
  'dispatch-dependency-admission',
  'same-session-retry-after-finalize',
  'landing-conflict-and-recovery',
  'resumed-output-isolation',
  'small-isolated-promotion',
  'all-manager-incidents',
] as const;

export const MANAGER_INCIDENT_REGRESSIONS: readonly RegressionCase[] = [
  {
    id: 'launch-strict-result-schema',
    incident: 'Launch and agent adapter: provider rejects the worker result schema',
    file: 'tools/goal/src/worker-result-schema.test.ts',
    testName: 'the worker result schema meets the strict output rules every worker launch is sent with',
  },
  {
    id: 'launch-codex-resume-argv',
    incident: 'Launch and agent adapter: exec resume receives -C after the subcommand',
    file: 'tools/goal/src/agent-adapters.test.ts',
    testName: 'a Codex resume passes the exec-only -C and -s before the resume subcommand, which refuses them',
  },
  {
    id: 'launch-systemd-unit-reuse',
    incident: 'Launch and agent adapter: a resumed launch reuses a loaded systemd unit',
    file: 'tools/goal/src/worker-slice.test.ts',
    testName: 'a relaunch of the same attempt gets a new unit name, since systemd refuses one still loaded',
  },
  {
    id: 'launch-systemd-null-stdio',
    incident: 'Launch and agent adapter: a failed systemd scope throws when stdio is null',
    file: 'tools/goal/src/worker-slice.test.ts',
    testName: 'a failed scope with inherited stdio falls back instead of throwing',
  },
  {
    id: 'launch-worker-check-prompt',
    incident: 'Launch and agent adapter: the prompt uses a worker-check form dev does not accept',
    file: 'tools/goal/src/check-wake.test.ts',
    testName: 'worker instructions start detached checks, keep working, and return waiting without polling',
  },
  {
    id: 'launch-worker-check-required',
    incident: 'Launch and agent adapter: a main based task has no mandatory dev check runner',
    file: 'tools/goal/src/lifecycle-suite.test.ts',
    testName: 'the required dev worker-check runner fails closed when it is absent',
  },
  {
    id: 'waiting-live-start-record',
    incident: 'Waiting and wake: a running worker-check start record is read as terminal',
    file: 'tools/goal/src/check-wake.test.ts',
    testName: 'a check whose start record shows a live runner keeps the attempt waiting; a dead runner wakes it',
  },
  {
    id: 'waiting-fresh-resume-output',
    incident: 'Waiting and wake: a resumed launch reuses the previous turn exit object',
    file: 'tools/goal/src/stale-exit.test.ts',
    testName: 'a resumed launch failure is settled from its appended output, not the prior waiting result',
  },
  {
    id: 'waiting-labelled-check-ids',
    incident: 'Waiting and wake: labelled check ids are refused',
    file: 'tools/goal/src/agent-adapters.test.ts',
    testName: 'a waiting exit whose check entries label their ids still yields the ids',
  },
  {
    id: 'waiting-real-check-wake',
    incident: 'Waiting and wake: a completed real check does not wake its worker',
    file: 'tools/goal/src/check-wake.test.ts',
    testName: 'waiting workers release their cap slot and resume the same session with every completed check result',
  },
  {
    id: 'retry-same-session-after-finalize',
    incident: 'Retry and session: a fix round starts a fresh provider session',
    file: 'tools/goal/src/agent-adapters.test.ts',
    testName: 'fix-round retries use the adapter session only for the same pool and model',
  },
  {
    id: 'retry-waits-for-dependency',
    incident: 'Retry and session: a retry starts while its dependency is unmet',
    file: 'tools/goal/src/held-reshape-priority.test.ts',
    testName: 'a stopped task retried while a dependency is unmet is held instead of started',
  },
  {
    id: 'retry-reshape-pending',
    incident: 'Retry and session: a held task cannot be reshaped while retry is pending',
    file: 'tools/goal/src/held-reshape-priority.test.ts',
    testName: 'retry --brief amends a held task whose retry is already pending and keeps that retry',
  },
  {
    id: 'retry-reshape-waiting',
    incident: 'Retry and session: a held task cannot be reshaped while its attempt waits for checks',
    file: 'tools/goal/src/held-reshape-priority.test.ts',
    testName: 'retry --brief amends a held task whose attempt waits for checks',
  },
  {
    id: 'retry-command-leaves-drained-work',
    incident: 'Retry and session: the command queuing work waits for unrelated drained work',
    file: 'tools/goal/src/durable-follow-up.test.ts',
    testName: "a command leaves another task's pending retry to the host instead of running it first",
  },
  {
    id: 'landing-orphaned-queue-entry',
    incident: 'Landing train: a task is left in landing without a queue entry',
    file: 'tools/goal/src/orphaned-landings.test.ts',
    testName: 'the host sweep retries an orphaned landing only after train work ends and reports it once',
  },
  {
    id: 'landing-integrated-batch-member',
    incident: 'Landing train: an already integrated member poisons the batch',
    file: 'tools/goal/src/orphaned-landings.test.ts',
    testName: 'a batch drops an already integrated member and lands the remaining members',
  },
  {
    id: 'landing-pinned-bun-single-rebase',
    incident: 'Landing train: a single rebase lacks dependencies and pinned Bun',
    file: 'tools/goal/src/hot-file-holds.test.ts',
    testName: 'a bun.lock-only rebase conflict on retry keeps integration, installs, stages and continues',
  },
  {
    id: 'landing-pinned-bun-promotion-worktree',
    incident: 'Landing train: a merge-back worktree lacks dependencies and pinned Bun',
    file: 'tools/goal/src/derived-files.test.ts',
    testName: 'promotion installs dependencies in the derived worktree before running a generator that needs them',
  },
  {
    id: 'landing-conflict-bounded-recovery',
    incident: 'Landing train: a conflict loops hundreds of retries instead of bounded recovery',
    file: 'tools/goal/src/rebase-conflict.test.ts',
    testName:
      'a rebase conflict starts a same-profile resolution attempt and legacy outcomes without Git context keep retrying',
  },
  {
    id: 'landing-unfreeze-retains-file',
    incident: 'Landing train: unfreezing deletes an existing acceptance file',
    file: 'tools/goal/src/unfreeze-keeps-files.test.ts',
    testName:
      'when a reshaped brief stops freezing a file that exists on the task base, the file is restored to its base content, not deleted',
  },
  {
    id: 'landing-format-only-effective-change',
    incident: 'Landing train: an effective formatting-only change is refused as no effect',
    file: 'tools/goal/src/integration-format.test.ts',
    testName: "integration formats the task's changed files and dev receives formatted content",
  },
  {
    id: 'promotion-capability-is-not-gate',
    incident: 'Promotion: capability manifests are treated as a gate',
    file: 'tools/goal/src/promotion-commands.test.ts',
    testName: 'promotion gates on the root gate and promoted acceptance, never on capability completion',
  },
  {
    id: 'promotion-full-gate-timeout',
    incident: 'Promotion: the full gate is stopped by a two hour timeout',
    file: 'tools/goal/src/promotion-commands.test.ts',
    testName: 'a promotion gate may run as long as a full root gate takes',
  },
  {
    id: 'promotion-main-ancestry-recovery',
    incident: 'Promotion: main moving off the candidate ancestry leaves promotion silently stalled',
    file: 'tools/goal/src/promotion-stabilize.test.ts',
    testName: 'a snapshot gated while main took any other commit is dropped for a fresh gate',
  },
  {
    id: 'admission-start-reservation',
    incident: 'Capacity and admission: concurrent admission passes the worker cap',
    file: 'tools/goal/src/admission-reservation.test.ts',
    testName: 'admitted starts retain capacity throughout delayed preparation until running attempts take over',
  },
  {
    id: 'admission-reservation-release',
    incident: 'Capacity and admission: a stale slot reservation remains pinned after a fix lands',
    file: 'tools/goal/src/admission-reservation.test.ts',
    testName: 'a failed launch releases its admitted place for a later waiter',
  },
  {
    id: 'capacity-remote-install-failure',
    incident: 'Capacity and admission: remote Bun installation failures are not classified as infrastructure',
    file: 'tools/goal/src/launch-failure.test.ts',
    testName: 'failed check-host Bun downloads are transport failures without hiding task failures',
  },
  {
    id: 'notice-long-attempt-deduplication',
    incident: 'Notices: a long attempt notice repeats every minute',
    file: 'tools/goal/src/long-attempt-notice.test.ts',
    testName:
      'a long attempt is reported once when it crosses the threshold, then at most once an hour while its last command and commit count are unchanged',
  },
  {
    id: 'notice-stale-watchdog-alert',
    incident: 'Notices: stale watchdog results cause repeated alerts',
    file: 'tools/goal/src/watchdog.test.ts',
    testName:
      'a sweep judges the probe results the previous sweep started, and two failures in a row report the host once',
  },
];

export const LIFECYCLE_SUITE_TESTS: readonly LifecycleTestCase[] = [
  {
    id: 'suite-native-stop-custody',
    file: 'tools/goal/src/stop-custody-and-held-contract.test.ts',
    testName:
      'normal stop ends exactly its owned detached check process tree with honest terminal custody, no peer kill or duplicate new check',
  },
  {
    id: 'suite-held-contract',
    file: 'tools/goal/src/stop-custody-and-held-contract.test.ts',
    testName: 'unstarted held retry --brief preserves task identity, attempt 0, work, dependencies, and releases once',
  },
  {
    id: 'suite-dependency-base',
    file: 'tools/goal/src/dependency-base.test.ts',
    testName: 'a dependent starts from dev when its dependency landed after dev-verified, and has the dependency code',
  },
  {
    id: 'suite-worker-check-prerequisite',
    file: 'tools/goal/src/lifecycle-suite.test.ts',
    testName: 'the required dev worker-check runner fails closed when it is absent',
    scenarioId: 'dev-worker-check-fail-closed',
  },
  {
    id: 'suite-systemd-prerequisite',
    file: 'tools/goal/src/lifecycle-suite.test.ts',
    testName: 'the real systemd prerequisite fails closed when systemd-run is not on PATH',
  },
  {
    id: 'suite-small-promotion',
    file: 'tools/goal/src/lifecycle-suite.test.ts',
    testName: 'small isolated promotion verifies ancestry, exact checked commit, and fast failure classification',
    scenarioId: 'small-isolated-promotion',
  },
  {
    id: 'suite-completion-gate',
    file: 'tools/goal/src/lifecycle-suite.test.ts',
    testName: 'lifecycle completion refuses any missing scenario or incident regression',
    scenarioId: 'lifecycle-evidence-completeness',
  },
];

export type ExecutedRegression = {
  id: string;
  incident?: string;
  file: string;
  testName: string;
  status: 'passed' | 'failed' | 'unverified';
  durationMs: number;
  evidence: string;
};

export type ScenarioEvidence = {
  id: string;
  status: 'passed' | 'failed' | 'unverified';
  evidence?: unknown;
  detail?: string;
};

/** Parity is a separate postintegration obligation; minimal smoke still runs the real provider path. */
export async function gateParityScenario(options: {
  policy?: ControlPolicy | undefined;
  root: string;
  scriptsRoot?: string;
  execute?: boolean;
  report?: (line: string) => void;
}): Promise<ScenarioEvidence> {
  if (!options.execute)
    return {
      id: 'worker-root-workspace-gate-parity',
      status: 'unverified',
      detail:
        'Deferred in minimal mode; actual Auth placement, synced Git and concurrent runtime parity require explicit postintegration execution.',
    };
  if (!options.scriptsRoot)
    throw new Error('Explicit parity execution requires --scripts-root <delivered-dev-checkout>');
  const result = await driveGateParity({
    inputRoot: options.root,
    policy: options.policy,
    scriptsRoot: options.scriptsRoot,
    execute: true,
    report: (plan) => (options.report ?? console.log)(JSON.stringify({ phase: 'parity-plan', ...plan })),
  });
  return {
    id: 'worker-root-workspace-gate-parity',
    status: result.status === 'failed' ? 'failed' : 'unverified',
    detail: `Parity ${result.status}; delivered producer evidence cannot replace unavailable end-to-end boundaries.`,
    evidence: result,
  };
}

export function assertLifecycleComplete(report: {
  scenarios: readonly { id: string; status: string }[];
  incidents: readonly { id: string; status: string }[];
}): void {
  const missingScenarios = REQUIRED_LIFECYCLE_SCENARIOS.filter(
    (id) => !report.scenarios.some((scenario) => scenario.id === id && scenario.status === 'passed'),
  );
  const missingIncidents = MANAGER_INCIDENT_REGRESSIONS.filter(
    (required) => !report.incidents.some((incident) => incident.id === required.id && incident.status === 'passed'),
  );
  if (missingScenarios.length || missingIncidents.length) {
    const details = [
      ...(missingScenarios.length ? [`scenarios: ${missingScenarios.join(', ')}`] : []),
      ...(missingIncidents.length ? [`incidents: ${missingIncidents.map(({ id }) => id).join(', ')}`] : []),
    ];
    throw new Error(`lifecycle evidence is incomplete (${details.join('; ')})`);
  }
}

export async function runNamedLifecycleRegressions(options: {
  policy?: ControlPolicy | undefined;
  root: string;
  artifactDirectory?: string;
  deadline: number;
  onRegression: (result: ExecutedRegression) => void;
  onSuiteRegression: (result: ExecutedRegression) => void;
  onScenario: (scenario: ScenarioEvidence) => void;
  report: (line: string) => void;
}): Promise<{ incidents: ExecutedRegression[]; suite: ExecutedRegression[] }> {
  const policy = options.policy ?? defaultPolicy;
  const allCases = [...MANAGER_INCIDENT_REGRESSIONS, ...LIFECYCLE_SUITE_TESTS];
  const groups = new Map<string, (RegressionCase | LifecycleTestCase)[]>();
  for (const testCase of allCases) {
    const group = groups.get(testCase.file) ?? [];
    group.push(testCase);
    groups.set(testCase.file, group);
  }

  const incidents: ExecutedRegression[] = [];
  const suite: ExecutedRegression[] = [];
  const scenarioDirectory = join(options.root, '.temp/goal/lifecycle-smoke');
  mkdirSync(scenarioDirectory, { recursive: true });
  for (const [file, cases] of groups) {
    const absoluteFile = `${options.root}/${file}`;
    const source = await Bun.file(absoluteFile).text();
    for (const testCase of cases)
      if (!source.includes(testCase.testName))
        throw new Error(`required executable regression is missing: ${file} :: ${testCase.testName}`);

    const pattern = `(?:${cases.map(({ testName }) => escapeRegExp(testName)).join('|')})`;
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`capacity timeout: lifecycle regressions/${file} is unverified`);
    const promotionEvidencePath = join(scenarioDirectory, `promotion-${randomUUID()}.json`);
    const result: BoundedProcessResult = await runBoundedProcess(
      process.execPath,
      ['test', '--timeout', String(policy.lifecycleRegressions.testTimeoutMs), '--test-name-pattern', pattern, file],
      {
        cwd: options.root,
        env: {
          ...process.env,
          REZICS_LIFECYCLE_EVIDENCE: '1',
          REZICS_LIFECYCLE_SCENARIO_REPORT: promotionEvidencePath,
        },
        policy: policy.launchSmoke,
        timeoutMs: Math.min(policy.lifecycleRegressions.commandTimeoutMs, remainingMs),
      },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const passCount = Number(/(?:^|\s)(\d+)\s+pass\b/i.exec(output)?.[1] ?? 0);
    const expectedCount = new Set(cases.map(({ testName }) => testName)).size;
    const capacityTimeout =
      result.timedOut || (/test timed out after \d+ms/i.test(output) && /Waiting for host capacity/i.test(output));
    const status: ExecutedRegression['status'] = capacityTimeout
      ? 'unverified'
      : result.status === 0
        ? 'passed'
        : 'failed';
    const complete = status === 'passed' && passCount >= expectedCount;
    const caseStatus = complete ? 'passed' : capacityTimeout ? 'unverified' : 'failed';
    let evidence = complete
      ? `executed ${passCount} selected tests; ${result.durationMs}ms`
      : `${capacityTimeout ? 'capacity timeout: unverified' : `expected ${expectedCount} selected passing tests, observed ${passCount}; exit ${String(result.status)}`}${output ? `; ${output.slice(-policy.lifecycleRegressions.diagnosticCharacters)}` : ''}`;
    if (!complete) {
      const logPath = join(
        options.artifactDirectory ?? scenarioDirectory,
        `regression-${file.replace(/[^a-z0-9.-]+/gi, '-')}-${randomUUID()}.log`,
      );
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `${output}\n`, { mode: 0o600 });
      evidence += `; bounded log: ${logPath}`;
    }

    for (const testCase of cases) {
      const record: ExecutedRegression = {
        id: testCase.id,
        ...('incident' in testCase ? { incident: testCase.incident } : {}),
        file,
        testName: testCase.testName,
        status: caseStatus,
        durationMs: result.durationMs,
        evidence,
      };
      if ('incident' in testCase) {
        incidents.push(record);
        options.onRegression(record);
      } else {
        suite.push(record);
        options.onSuiteRegression(record);
        if (testCase.scenarioId) {
          let scenarioEvidence: unknown;
          if (testCase.scenarioId === 'small-isolated-promotion' && complete) {
            if (!(await Bun.file(promotionEvidencePath).exists()))
              throw new Error('small promotion passed without machine-readable scenario evidence');
            try {
              scenarioEvidence = JSON.parse(readFileSync(promotionEvidencePath, 'utf8'));
            } catch (error) {
              throw new Error(`small promotion emitted invalid scenario evidence: ${String(error)}`);
            } finally {
              rmSync(promotionEvidencePath, { force: true });
            }
          }
          options.onScenario({
            id: testCase.scenarioId,
            status: caseStatus,
            ...(scenarioEvidence ? { evidence: scenarioEvidence } : {}),
            ...(!complete ? { detail: evidence } : {}),
          });
        }
      }
    }

    options.report(
      complete
        ? `regression group ${file}: passed (${expectedCount} named cases, ${result.durationMs}ms)`
        : `regression group ${file}: ${caseStatus}: ${evidence}`,
    );
    if (!complete) throw new Error(`regressions/${file}: ${evidence}`);
  }

  const passed = new Set(incidents.filter(({ status }) => status === 'passed').map(({ id }) => id));
  const suitePassed = new Set(suite.filter(({ status }) => status === 'passed').map(({ id }) => id));
  const scenarioStatus = (condition: boolean): 'passed' | 'failed' => (condition ? 'passed' : 'failed');
  options.onScenario({
    id: 'dispatch-dependency-admission',
    status: scenarioStatus(
      suitePassed.has('suite-dependency-base') &&
        passed.has('retry-waits-for-dependency') &&
        passed.has('admission-start-reservation'),
    ),
    evidence: { regressions: ['suite-dependency-base', 'retry-waits-for-dependency', 'admission-start-reservation'] },
  });
  options.onScenario({
    id: 'same-session-retry-after-finalize',
    status: scenarioStatus(passed.has('retry-same-session-after-finalize')),
    evidence: {
      regression: 'retry-same-session-after-finalize',
      boundary: 'production WorkerJob retry and provider-adapter session selection',
    },
  });
  options.onScenario({
    id: 'landing-conflict-and-recovery',
    status: scenarioStatus(
      passed.has('landing-conflict-bounded-recovery') &&
        passed.has('landing-integrated-batch-member') &&
        passed.has('landing-orphaned-queue-entry'),
    ),
    evidence: {
      regressions: [
        'landing-conflict-bounded-recovery',
        'landing-integrated-batch-member',
        'landing-orphaned-queue-entry',
      ],
      boundary: 'real Git, MergeTrain and durable landing queue fixtures',
    },
  });
  options.onScenario({
    id: 'resumed-output-isolation',
    status: scenarioStatus(passed.has('waiting-fresh-resume-output')),
    evidence: { regression: 'waiting-fresh-resume-output' },
  });
  options.onScenario({
    id: 'all-manager-incidents',
    status: scenarioStatus(
      incidents.length === MANAGER_INCIDENT_REGRESSIONS.length && passed.size === incidents.length,
    ),
    evidence: { count: incidents.length, ids: incidents.map(({ id }) => id) },
  });
  options.onScenario({
    id: 'remote-root-gate-group-performance-seam',
    status: 'unverified',
    evidence: {
      incident: 'one gate host runs root and promoted acceptance groups sequentially',
      source: 'dev:scripts/gate.ts',
      supportedSeam: 'runRemoteGroups starts both runRemoteGroup calls with Promise.all',
      existingFixture:
        'tools/goal/src/root-gate.test.ts exercises local workspace concurrency, not remote group dispatch',
      limitation: 'No remote-host fixture exercises group start timing; remote hosts remain untouched.',
    },
  });

  return { incidents, suite };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type SmallPromotionEvidence = {
  scenario: 'small-isolated-promotion';
  mainBase: string;
  candidate: string;
  checkedCommits: string[];
  publishedMain: string;
  mainBaseIsAncestor: boolean;
  mainAncestryVerifiedBeforePublication: boolean;
  checkedCommitIsPublished: boolean;
  infrastructureFailureRetries: number;
  infrastructureFailureClassified: boolean;
  elapsedMs: number;
};

export async function runSmallPromotionScenario(): Promise<SmallPromotionEvidence> {
  const h = integrationHarness();
  try {
    const observedInfrastructureReruns: {
      kind: 'promotion-infrastructure-rerun';
      command: string[];
      initial: { timedOut: boolean };
      result: { passed: boolean };
    }[] = [];
    const savePromotion = h.store.savePromotion.bind(h.store);
    h.store.savePromotion = (run) => {
      observedInfrastructureReruns.push(...(run.infrastructureReruns ?? []));
      savePromotion(run);
    };
    h.settings.gate = ['fixture-root-gate'];
    await h.seed('promotion-alpha', [], ['fixture-alpha-acceptance']);
    await h.seed('promotion-beta', [], ['fixture-beta-acceptance']);

    const mainBase = h.head('main');
    const candidate = h.head('dev');
    const checkedCommits: string[] = [];
    const ancestryChecks: boolean[] = [];
    const commandRuns = new Map<string, number>();
    const startedAt = Date.now();
    const runGate = async (command: readonly string[], cwd: string) => {
      const commandName = command.join(' ');
      const checked = git(cwd, 'rev-parse', 'HEAD');
      checkedCommits.push(checked);
      try {
        git(h.root, 'merge-base', '--is-ancestor', mainBase, checked);
        ancestryChecks.push(true);
      } catch {
        ancestryChecks.push(false);
      }
      commandRuns.set(commandName, (commandRuns.get(commandName) ?? 0) + 1);
      // Fixture delay creates concurrent candidate checks; it does not bound a production command.
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (checked !== candidate)
        return { passed: false, output: `AssertionError: expected ${candidate}, checked ${checked}`, timedOut: false };
      if (commandName === 'fixture-alpha-acceptance' && commandRuns.get(commandName) === 1)
        return { passed: false, output: 'spawnSync docker run ETIMEDOUT', timedOut: true };
      return { passed: true, output: '', timedOut: false };
    };

    await h.promote(runGate);
    const elapsedMs = Date.now() - startedAt;
    const publishedMain = h.head('main');
    let mainBaseIsAncestor = false;
    try {
      git(h.root, 'merge-base', '--is-ancestor', mainBase, candidate);
      mainBaseIsAncestor = true;
    } catch {
      mainBaseIsAncestor = false;
    }
    const infrastructureFailureRetries = Math.max(0, (commandRuns.get('fixture-alpha-acceptance') ?? 0) - 1);
    const infrastructureFailureClassified = observedInfrastructureReruns.some(
      (retry) =>
        retry.kind === 'promotion-infrastructure-rerun' &&
        retry.initial.timedOut &&
        retry.command.join(' ') === 'fixture-alpha-acceptance' &&
        retry.result.passed,
    );
    const evidence: SmallPromotionEvidence = {
      scenario: 'small-isolated-promotion',
      mainBase,
      candidate,
      checkedCommits,
      publishedMain,
      mainBaseIsAncestor,
      mainAncestryVerifiedBeforePublication: ancestryChecks.length > 0 && ancestryChecks.every(Boolean),
      checkedCommitIsPublished:
        checkedCommits.length > 0 &&
        checkedCommits.every((commit) => commit === candidate) &&
        publishedMain === candidate,
      infrastructureFailureRetries,
      infrastructureFailureClassified,
      elapsedMs,
    };
    if (!evidence.mainBaseIsAncestor) throw new Error('main was not an ancestor of the checked promotion candidate');
    if (!evidence.mainAncestryVerifiedBeforePublication)
      throw new Error('the promotion did not gate a candidate descended from main before publication');
    if (!evidence.checkedCommitIsPublished) throw new Error('promotion did not publish the exact checked candidate');
    if (infrastructureFailureRetries !== 1)
      throw new Error('promotion did not classify and retry the injected infrastructure failure');
    if (!infrastructureFailureClassified)
      throw new Error('promotion did not persist the infrastructure-only failure classification and passing retry');
    // Fixed regression assertion defines the small-promotion fixture, not operator execution policy.
    if (elapsedMs >= 60_000) throw new Error(`small promotion exceeded its bounded scenario time: ${elapsedMs}ms`);
    return evidence;
  } finally {
    h.dispose();
  }
}
