#!/usr/bin/env bun
/** Durable records for physical check runs. Ledger writes are best effort. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type CheckLedgerEntry = {
  runId: string; logicalCheckId?: string; rerunNumber?: number; host?: string; argv: string[]; revision?: string;
  start: string; end?: string; exitStatus?: number; terminalStatus: string; infrastructureCause?: string;
  slotWaitSeconds?: number; phases?: Record<string, number>; commandPhases?: Record<string, number>;
  memoryGiBSeconds?: number; swapGiBSeconds?: number; memoryPeakBytes?: number; swapPeakBytes?: number;
  sampleCount?: number; samplingIntervalSeconds?: number; pressureStallSeconds?: number; cpuSeconds?: number;
};

export function mainCheckout(cwd: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, stdout: 'pipe', stderr: 'ignore' });
  const common = result.stdout.toString().trim();
  return result.exitCode === 0 && common ? dirname(common) : resolve(cwd);
}

export function ledgerPath(entry: CheckLedgerEntry, checkout: string): string {
  const day = entry.start.slice(0, 10);
  return join(checkout, '.temp', 'check-ledger', day, `${entry.runId}.json`);
}

export function writeLedger(entry: CheckLedgerEntry, checkout: string, warn: (message: string) => void = console.warn): void {
  try {
    const file = ledgerPath(entry, checkout);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) { warn(`check-ledger: could not write ledger entry: ${String(error)}`); }
}

export function commandClass(argv: string[]): string {
  const text = argv.join(' ');
  if (/services\/kernel|kernel.*\bcheck\b/i.test(text)) return 'kernel check';
  if (/services\/auth|auth.*\bcheck\b/i.test(text)) return 'auth check';
  if (/apps\/web|packages\/ui|web.*\b(check|test|build)\b/i.test(text)) return 'web check';
  if (/typecheck/i.test(text) && /--cwd|workspace|services\//i.test(text)) return 'workspace typecheck';
  if (/typecheck/i.test(text)) return 'root typecheck';
  if (/scripts\/|bun test/i.test(text)) return 'script and control-plane tests';
  return 'other';
}

export function summarize(entries: CheckLedgerEntry[], since: Date, until: Date): object {
  const classes: Record<string, { checkHours: number; memoryGiBHours: number }> = {};
  const phases: Record<string, { checkHours: number; memoryGiBHours: number }> = {};
  let terminal = 0, infrastructure = 0, samples = 0, intervals: number[] = [];
  for (const e of entries) {
    const start = Date.parse(e.start), end = Date.parse(e.end ?? until.toISOString());
    if (!Number.isFinite(start) || start >= until.getTime() || end <= since.getTime()) continue;
    const seconds = Math.max(0, (Math.min(end, until.getTime()) - Math.max(start, since.getTime())) / 1000);
    const memoryHours = e.memoryGiBSeconds === undefined ? 0 : e.memoryGiBSeconds / 3600 * seconds / Math.max(1, (end - start) / 1000);
    const className = commandClass(e.argv);
    for (const [map, name, h, m] of [[classes, className, seconds / 3600, memoryHours], [phases, 'run', seconds / 3600, memoryHours]] as const) {
      map[name] ??= { checkHours: 0, memoryGiBHours: 0 }; map[name]!.checkHours += h; map[name]!.memoryGiBHours += m;
    }
    for (const [phase, duration] of Object.entries(e.phases ?? {})) {
      phases[phase] ??= { checkHours: 0, memoryGiBHours: 0 };
      phases[phase]!.checkHours += duration / 3600;
    }
    if (e.end) { terminal++; if (e.infrastructureCause) infrastructure++; }
    samples += e.sampleCount ?? 0; if (e.samplingIntervalSeconds) intervals.push(e.samplingIntervalSeconds);
  }
  return { window: { since: since.toISOString(), until: until.toISOString() }, byCommandClass: classes, byPhase: phases,
    infrastructureShare: terminal ? infrastructure / terminal : 0, limits: { sampleCount: samples, samplingIntervalSeconds: intervals.length ? Math.max(...intervals) : null, memoryScope: 'Memory outside the run slice (host-shared services) is not counted.' } };
}

function main(argv: string[]): void {
  if (argv[0] !== 'summary') throw new Error('Usage: check-ledger.ts summary --since <ISO> [--until <ISO>]');
  const value = (flag: string): string | undefined => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };
  const since = new Date(value('--since') ?? ''), until = new Date(value('--until') ?? new Date().toISOString());
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) throw new Error('summary requires a valid increasing time window');
  const checkout = mainCheckout(process.cwd()), root = join(checkout, '.temp', 'check-ledger');
  const entries: CheckLedgerEntry[] = [];
  try { for (const day of readdirSync(root)) for (const file of readdirSync(join(root, day))) if (file.endsWith('.json')) {
    try { entries.push(JSON.parse(readFileSync(join(root, day, file), 'utf8')) as CheckLedgerEntry); } catch { /* ignore unreadable entries */ }
  } } catch { /* empty ledger */ }
  process.stdout.write(`${JSON.stringify(summarize(entries, since, until), null, 2)}\n`);
}
if (import.meta.main) { try { main(Bun.argv.slice(2)); } catch (error) { console.error(String(error)); process.exitCode = 1; } }
