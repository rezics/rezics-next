import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultPolicy, type ControlPolicy } from '../src/policy.ts';
import type { AgentAdapter, AgentLaunchOptions } from '../src/agents.ts';
import { writeEvidenceAtomically } from '../test-support/lifecycle-fixture.ts';
import type { ExecutedRegression, ScenarioEvidence } from '../test-support/lifecycle-scenarios.ts';

export const CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type SmokePolicy = ControlPolicy['launchSmoke'];

export function requireSmokeWaitingCheckId(checks: unknown): string {
  if (!Array.isArray(checks) || checks.length !== 1 || typeof checks[0] !== 'string' || !CHECK_ID.test(checks[0]))
    throw new Error('waiting result must contain one bare worker-check UUID');
  return checks[0];
}


export type SmokeReport = {
  version: 1;
  status: 'running' | 'passed' | 'failed' | 'unverified';
  startedAt: string;
  finishedAt?: string;
  candidate?: string;
  devScriptTree?: string;
  scenarios: ScenarioEvidence[];
  incidents: ExecutedRegression[];
  suiteRegressions: ExecutedRegression[];
  failure?: { step: string; detail: string; classification: 'failure' | 'infrastructure/unverified' };
};

export type Reporter = (line: string) => void;

export type SmokeLaunchEvidence = {
  mode: 'start' | 'resume';
  program: string;
  argv: string[];
  profile: AgentLaunchOptions['profile'];
  pool: string;
  worktree: string;
  session: string | null;
  configuredFeatures: Record<string, boolean>;
};
export function saveSmokeEvidence(
  path: string,
  evidence: unknown,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): void {
  let remaining = policy.evidenceBudgetBytes;
  const clean = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > policy.evidenceDepth) return '<truncated>';
    remaining -= 16;
    if (typeof value === 'string') {
      const redacted = value
        .replace(/\bsk-[\w-]+/g, '<redacted>')
        .replace(
          /((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)["']?\s*[:=]\s*)(?:Bearer\s+)?["']?[^\s,"'}]+/gi,
          '$1<redacted>',
        );
      let text = Buffer.from(redacted)
        .subarray(0, Math.max(0, Math.min(policy.evidenceStringBytes, remaining)))
        .toString('utf8');
      while (Buffer.byteLength(JSON.stringify(text)) > Math.max(2, Math.min(policy.evidenceStringBytes, remaining)))
        text = text.slice(0, Math.floor(text.length * 0.75));
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (Array.isArray(value)) return value.slice(0, policy.evidenceArrayItems).map((item) => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value).slice(0, policy.evidenceObjectEntries)) {
        if (remaining <= 0) break;
        remaining -= key.length + 8;
        entries.push([
          key.slice(0, policy.evidenceKeyCharacters),
          /(?:password|secret|api[_-]?key|(?:access|refresh|id)[_-]?token)/i.test(key)
            ? '<redacted>'
            : clean(item, depth + 1),
        ]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  const json = JSON.stringify(clean(evidence), null, 2);
  if (Buffer.byteLength(json) > policy.evidenceBytes) throw new Error('Smoke evidence exceeded its size bound');
  writeFileSync(`${path}.tmp`, json + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function safeSmokeArgv(args: string[]): string[] {
  const safe: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      safe.push('--', '<prompt omitted>');
      break;
    }
    if (arg === '-c') {
      const config = args[++i] ?? '';
      const allowed =
        /^(?:features\.[a-z_]+|model_reasoning_effort|model_auto_compact_token_limit|tool_output_token_limit|background_terminal_max_timeout|service_tier|model_context_window|approval_policy|web_search|project_doc_max_bytes)=([a-z_0-9.-]+|"[a-z_0-9.-]+")$/i;
      safe.push('-c', allowed.test(config) ? config : '<configuration omitted>');
    } else if (['-C', '-m', '-s', '--output-schema', 'resume'].includes(arg)) {
      safe.push(arg, args[++i] ?? '');
    } else safe.push(arg === 'exec' || /^--[a-z-]+$/.test(arg) ? arg : '<argument omitted>');
  }
  return safe;
}

/** Observe the actual adapter return value without changing argv, routing, or session semantics. */
export function observeSmokeAdapter(adapter: AgentAdapter, record: (value: SmokeLaunchEvidence) => void): AgentAdapter {
  const observe = (mode: 'start' | 'resume', options: AgentLaunchOptions, command: [string, string[]]) => {
    const configuredFeatures: Record<string, boolean> = {};
    if (adapter.cli === 'codex') {
      const config = join(options.pool.configDirectory, 'config.toml');
      if (existsSync(config)) {
        const parsed = Bun.TOML.parse(readFileSync(config, 'utf8')) as { features?: Record<string, unknown> };
        for (const [name, value] of Object.entries(parsed.features ?? {}))
          if (typeof value === 'boolean') configuredFeatures[name] = value;
      }
    }
    record({
      mode,
      program: command[0],
      argv: safeSmokeArgv(command[1]),
      profile: options.profile,
      pool: options.pool.name,
      worktree: options.worktree,
      session: options.resumeSession ?? null,
      configuredFeatures,
    });
    return command;
  };
  return {
    ...adapter,
    start(options) {
      return observe('start', options, adapter.start(options));
    },
    resume(options) {
      return observe('resume', { ...options, resumeSession: options.session }, adapter.resume(options));
    },
  };
}

/** Only the current run's bounded suffix; omit raw tool arguments, environment and tool output. */
export function smokeRunSuffix(
  path: string,
  offset: number,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): unknown[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(offset, size - policy.logTailBytes);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.subarray(0, count).toString('utf8').split(/\r?\n/);
    if (start > offset) lines = lines.slice(1);
    return lines
      .flatMap((line): unknown[] => {
        try {
          const event = JSON.parse(line);
          const item = event.item ?? event.payload ?? {};
          return [
            {
              type: event.type,
              itemType: item.type,
              status: item.status,
              toolName: item.name ?? item.tool_name,
              exitCode: item.exit_code,
              error: event.error?.message ?? item.error?.message,
              text: item.type === 'agent_message' ? item.text : undefined,
              usage: event.usage,
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(-policy.logEvents);
  } finally {
    closeSync(fd);
  }
}

export function smokeStderrSuffix(path: string, policy: SmokePolicy): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, policy.stderrBytes));
    return buffer
      .subarray(0, readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)))
      .toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function reportLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function message(error: unknown, policy: SmokePolicy = defaultPolicy.launchSmoke): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, policy.diagnosticCharacters);
}

export function stepFailure(
  step: string,
  error: unknown,
  report: Reporter,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): Error {
  const detail = message(error, policy);
  report(`${step}: failed: ${detail}`);
  return new Error(`${step}: ${detail}`);
}

export function smokeTools(policy: SmokePolicy) {
  const checked = (
    command: string,
    args: string[],
    cwd: string,
    timeout = policy.commandTimeoutMs,
    env = process.env,
  ): string => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: policy.outputBytes });
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit ${result.status}`;
      throw new Error(`${command} ${args[0] ?? ''}: ${detail}`);
    }
    return result.stdout.trim();
  };
  return {
    checked,
    git: (cwd: string, ...args: string[]) => checked('git', args, cwd),
    message: (error: unknown) => message(error, policy),
    stepFailure: (step: string, error: unknown, report: Reporter) => stepFailure(step, error, report, policy),
  };
}

export function resolveSmokeReportPath(root: string, requested?: string): string {
  const canonicalRoot = realpathSync(root);
  const path = resolve(canonicalRoot, requested ?? join('.temp/goal/lifecycle-smoke', `report-${randomUUID()}.json`));
  const fromRoot = relative(canonicalRoot, path);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw new Error('lifecycle report path must stay inside the worktree');
  let component = canonicalRoot;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    component = join(component, part);
    try {
      if (lstatSync(component).isSymbolicLink())
        throw new Error('lifecycle report path cannot traverse a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return path;
}

export function persistReport(root: string, path: string, report: SmokeReport): void {
  writeEvidenceAtomically(path, report, join(root, '.temp/goal/lifecycle-smoke'));
}

export function readReport(path: string): SmokeReport {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lifecycle report is not an object');
  const report = value as SmokeReport;
  if (!Array.isArray(report.scenarios) || !Array.isArray(report.incidents) || !Array.isArray(report.suiteRegressions))
    throw new Error('lifecycle report is missing its evidence arrays');
  return report;
}

export function upsertScenario(report: SmokeReport, scenario: ScenarioEvidence): void {
  report.scenarios = report.scenarios.filter(({ id }) => id !== scenario.id);
  report.scenarios.push(scenario);
}

export function timeoutFailure(error: unknown): boolean {
  return /ETIMEDOUT|capacity timeout|infrastructure\/unverified|exceeded .*budget|deadline|timed? ?out|timeout/i.test(
    message(error),
  );
}

export function parseJsonLine(text: string, label: string): Record<string, unknown> {
  const line = text.trim().split(/\r?\n/).at(-1) ?? '';
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} did not return a JSON object: ${message(error)}`);
  }
}

export function parseProviderObject(text: string, label: string): Record<string, unknown> {
  const candidates = [text.trim(), ...text.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (isWorkerResultObject(record)) return record;
      const events = [record, record.item, record.payload, record.message];
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        const item = event as Record<string, unknown>;
        if (item.type !== 'agent_message' || typeof item.text !== 'string') continue;
        try {
          const response: unknown = JSON.parse(item.text);
          if (response && typeof response === 'object' && !Array.isArray(response)) {
            const result = response as Record<string, unknown>;
            if (isWorkerResultObject(result)) return result;
          }
        } catch {
          // The strict provider response must be a JSON object inside the Codex agent_message event.
        }
      }
    } catch {
      // Codex may surround a strict JSON answer with JSONL event framing; try the next complete line.
    }
  }
  throw new Error(`${label} did not return a JSON result object`);
}

function isWorkerResultObject(value: Record<string, unknown>): boolean {
  const keys = ['approaches', 'blocker', 'checks', 'status', 'summary'];
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

export async function waitForCheck(
  resultPath: string,
  deadline: number,
  policy: SmokePolicy,
): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        const result: unknown = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result is not an object');
        const record = result as Record<string, unknown>;
        if (record.status === 'finished') return record;
      } catch (error) {
        if (error instanceof SyntaxError) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.pollMs));
          continue;
        }
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.pollMs));
  }
  throw new Error('worker-check result did not arrive before the smoke deadline');
}

export function persistFailureLog(reportPath: string, step: string, contents: string): string {
  const filename = `lifecycle-${step.replace(/[^a-z0-9.-]+/gi, '-')}-${randomUUID()}.log`;
  const path = join(dirname(reportPath), filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  return path;
}

