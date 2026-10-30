import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readHosts, type Host } from '../../../scripts/remote-check.ts';
import type { PromotionRun, PromotionPlacementSnapshot, Settings } from './types.ts';

export const PROMOTION_GATE_SLOTS = 3;
export const PROMOTION_KERNEL_CONCURRENCY = 5;
export const PROMOTION_GATE_HOST = 'c';
export const PROMOTION_EXPRESS_SLOTS_PER_HOST = 1;

const expected = {
  a: { slots: 5, memoryMaxGiB: 28, cpuQuotaPercent: 1100 },
  b: { slots: 7, memoryMaxGiB: 58, cpuQuotaPercent: 1500 },
  c: { slots: 5, memoryMaxGiB: 24, cpuQuotaPercent: 4800 },
} as const;

export type PreparedPromotionGate = {
  command: string[];
  snapshot: PromotionPlacementSnapshot;
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootGateCommand(command: readonly string[]): boolean {
  return command.some((part, index) => part === 'scripts/gate.ts' && command[index - 1] === 'bun');
}

function configuredSourcePath(settings: Settings): string {
  const configured = settings.promotionPlacement?.ordinaryHostsFile;
  if (!configured) {
    throw new Error(
      'promotionPlacement.ordinaryHostsFile is required; configure the untracked ordinary remote-check hosts file before promotion',
    );
  }
  const file = resolve(configured);
  try {
    accessSync(file, constants.R_OK);
  } catch (error) {
    throw new Error(`promotion ordinary host input ${file} is not readable: ${error instanceof Error ? error.message : error}`);
  }
  const relativePath = relative(settings.mainCheckout, file);
  if (relativePath && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relativePath)) {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
      cwd: settings.mainCheckout,
      encoding: 'utf8',
    });
    if (tracked.status === 0) throw new Error(`promotion ordinary host input ${file} must remain untracked`);
  }
  return file;
}

function validateOrdinaryHosts(hosts: Host[]): { selected: Host; totalOrdinarySlots: number; cOrdinarySlots: number } {
  const names = hosts.map((host) => host.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`promotion ordinary host input has duplicate hosts: ${[...new Set(duplicates)].join(', ')}`);
  const expectedNames = Object.keys(expected);
  const actualNames = [...names].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`promotion ordinary host topology must be exactly a,b,c; received ${actualNames.join(', ') || 'none'}`);
  }

  const ordinary = hosts.map((host) => ({ host, slots: host.slots - PROMOTION_EXPRESS_SLOTS_PER_HOST }));
  const withoutExpress = ordinary.filter(({ slots }) => slots < 1);
  if (withoutExpress.length) {
    throw new Error(`promotion ordinary hosts must each retain a slot after express capacity: ${withoutExpress.map(({ host }) => host.name).join(', ')}`);
  }
  const totalOrdinarySlots = ordinary.reduce((sum, entry) => sum + entry.slots, 0);
  const cOrdinarySlots = ordinary.find(({ host }) => host.name === PROMOTION_GATE_HOST)?.slots ?? 0;
  if (cOrdinarySlots < PROMOTION_GATE_SLOTS + 1) {
    throw new Error(
      `promotion needs ${PROMOTION_GATE_SLOTS} slots on c and must leave one ordinary slot; c has ${cOrdinarySlots}`,
    );
  }
  if (totalOrdinarySlots !== 14) {
    throw new Error(`promotion ordinary host capacity must total 14 slots after express capacity; received ${totalOrdinarySlots}`);
  }

  for (const host of hosts) {
    const baseline = expected[host.name as keyof typeof expected];
    if (
      host.slots !== baseline.slots ||
      host.memoryMaxGiB !== baseline.memoryMaxGiB ||
      host.cpuQuotaPercent !== baseline.cpuQuotaPercent
    ) {
      throw new Error(
        `promotion ordinary host ${host.name} differs from the measured topology (slots ${baseline.slots}, memoryMaxGiB ${baseline.memoryMaxGiB}, cpuQuotaPercent ${baseline.cpuQuotaPercent})`,
      );
    }
  }

  return { selected: ordinary.find(({ host }) => host.name === PROMOTION_GATE_HOST)!.host, totalOrdinarySlots, cOrdinarySlots };
}

function envCommand(command: readonly string[], hostsFile: string): string[] {
  if (command[0] !== 'env') throw new Error('promotion root gate must use an explicit env command for remote host routing');
  let index = 1;
  const assignments: string[] = [];
  while (index < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) {
    assignments.push(command[index]!);
    index++;
  }
  if (command[index] !== 'bun' || command[index + 1] !== 'scripts/gate.ts' || index + 2 !== command.length) {
    throw new Error('promotion root gate must invoke the supported `bun scripts/gate.ts` command');
  }

  const relevant = new Set(['KERNEL_CHECK_REMOTE', 'KERNEL_CHECK_CONCURRENCY', 'GATE_REMOTE_SLOTS', 'GATE_CONCURRENCY']);
  const seen = new Set<string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    const key = assignment.slice(0, separator);
    if (key === 'KERNEL_CHECK_ON_REMOTE') {
      throw new Error('promotion root gate cannot set the local-only KERNEL_CHECK_ON_REMOTE flag');
    }
    if (relevant.has(key) && seen.has(key)) {
      throw new Error(`promotion root gate has ambiguous ${key} assignments`);
    }
    seen.add(key);
  }
  const overrides = new Map([
    ['KERNEL_CHECK_REMOTE', hostsFile],
    ['KERNEL_CHECK_CONCURRENCY', String(PROMOTION_KERNEL_CONCURRENCY)],
    ['GATE_REMOTE_SLOTS', String(PROMOTION_GATE_SLOTS)],
  ]);
  const assigned = new Set<string>();
  const rewritten = assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    const key = assignment.slice(0, separator);
    const value = overrides.get(key);
    if (value === undefined) return assignment;
    assigned.add(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of overrides) if (!assigned.has(key)) rewritten.push(`${key}=${value}`);
  return ['env', ...rewritten, ...command.slice(index)];
}

/** Read the configured ordinary host source, preserve its c projection, and prepare the existing remote gate route. */
export function preparePromotionGate(
  settings: Settings,
  run: PromotionRun,
  command: readonly string[],
): PreparedPromotionGate | null {
  if (!rootGateCommand(command)) return null;
  if (JSON.stringify(command) !== JSON.stringify(settings.gate)) {
    throw new Error('persisted promotion root gate differs from current settings; refusing stale host placement');
  }
  const outputPath = join(settings.stateDirectory, 'promotion-gate-hosts.json');
  const preparedCommand = envCommand(command, outputPath);
  const sourcePath = configuredSourcePath(settings);
  if (sourcePath === outputPath) throw new Error('promotion derived hosts file cannot also be the ordinary host input');
  let sourceBytes: Buffer;
  let hosts: Host[];
  try {
    sourceBytes = readFileSync(sourcePath);
    hosts = readHosts(sourcePath);
  } catch (error) {
    throw new Error(`could not read promotion ordinary host input ${sourcePath}: ${error instanceof Error ? error.message : error}`);
  }
  const { selected, totalOrdinarySlots, cOrdinarySlots } = validateOrdinaryHosts(hosts);
  const hostProjection = JSON.stringify(selected);
  const snapshot: PromotionPlacementSnapshot = {
    sourcePath,
    sourceSha256: sha256(sourceBytes),
    hostsFile: outputPath,
    host: PROMOTION_GATE_HOST,
    hostProjectionSha256: sha256(hostProjection),
    gateSlots: PROMOTION_GATE_SLOTS,
    ordinarySlots: totalOrdinarySlots,
    cOrdinarySlots,
    retainedOrdinarySlots: totalOrdinarySlots - PROMOTION_GATE_SLOTS,
  };
  if (run.placement && JSON.stringify(run.placement) !== JSON.stringify(snapshot)) {
    throw new Error('promotion ordinary host input changed during this run; refusing to switch physical placement');
  }

  const contents = `${JSON.stringify({ hosts: [selected] }, null, 2)}\n`;
  mkdirSync(settings.stateDirectory, { recursive: true });
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== contents) {
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, contents, { mode: 0o600 });
      renameSync(temporary, outputPath);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
  run.placement = snapshot;
  return { command: preparedCommand, snapshot };
}
