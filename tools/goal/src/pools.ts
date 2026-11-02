import { isAgentCli } from './agents.ts';
import { choosePool, choosePoolWithFallback as chooseByAllowance } from './allowance.ts';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool, PoolReading, Profile } from './types.ts';
import { withoutAnnotations } from './local-settings.ts';

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function positive(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (zero ? 0 : 1))
    throw new Error(`invalid ${label}`);
  return value;
}
/** Accept fractional rates without rounding, while rejecting zero and nonfinite values. */
function positiveRate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
  return value;
}
function burnCeiling(value: unknown): number {
  return positiveRate(value, 'maxBurnPerHour');
}

/** Parse only the pool section so a live reload cannot change other process settings. */
export function readPoolPolicies(value: unknown, localFile: string): Pool[] {
  value = withoutAnnotations(value);
  if (!Array.isArray(value)) throw new Error('pools must be an array');
  const pools = value.map((raw: unknown) => {
    const pool = object(raw, 'pool');
    keys(pool, ['name', 'cli', 'classes', 'configDirectory', 'command', 'allowanceKey', 'usageFile', 'policy'], 'pool');
    if (!isAgentCli(pool.cli)) throw new Error('unsupported pool CLI');
    if (!Array.isArray(pool.classes) || !pool.classes.length || pool.classes.some((c) => typeof c !== 'string' || !c))
      throw new Error('pool classes required');
    const policy = object(pool.policy, 'pool policy');
    keys(
      policy,
      ['weight', 'reservePercent', 'reservePerHour', 'allowUnknown', 'maxAgeMs', 'maxBurnPerHour'],
      'pool policy',
    );
    if (typeof policy.allowUnknown !== 'boolean') throw new Error('allowUnknown must be explicit');
    const reservePercent = positive(policy.reservePercent, 'reservePercent', true);
    if (reservePercent >= 100) throw new Error('reservePercent must be less than 100');
    const command = text(pool.command, 'pool command');
    return {
      name: text(pool.name, 'pool name'),
      cli: pool.cli as Pool['cli'],
      classes: pool.classes as string[],
      configDirectory: resolve(dirname(localFile), text(pool.configDirectory, 'configDirectory')),
      command: command.includes('/') ? resolve(dirname(localFile), command) : command,
      allowanceKey: text(pool.allowanceKey, 'allowanceKey'),
      ...(pool.usageFile === undefined
        ? {}
        : { usageFile: resolve(dirname(localFile), text(pool.usageFile, 'usageFile')) }),
      policy: {
        weight: positive(policy.weight, 'weight'),
        reservePercent,
        allowUnknown: policy.allowUnknown,
        maxAgeMs: positive(policy.maxAgeMs, 'maxAgeMs'),
        ...(policy.reservePerHour === undefined
          ? {}
          : { reservePerHour: positiveRate(policy.reservePerHour, 'reservePerHour') }),
        ...(policy.maxBurnPerHour === undefined ? {} : { maxBurnPerHour: burnCeiling(policy.maxBurnPerHour) }),
      },
    };
  });
  if (new Set(pools.map((p) => p.name)).size !== pools.length) throw new Error('duplicate pool name');
  return pools;
}

export class PoolPolicyReloader {
  private version: string;
  private pools: Pool[];
  constructor(
    private readonly localFile: string,
    initial: Pool[],
    private readonly report: (message: string) => void,
  ) {
    this.pools = initial;
    this.version = this.fileVersion();
  }
  private fileVersion(): string {
    try {
      const stat = statSync(this.localFile, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return 'unreadable';
    }
  }
  /** The pools of the file's latest valid version; an invalid version keeps them and is reported once. */
  read(): Pool[] {
    const version = this.fileVersion();
    if (version === this.version) return this.pools;
    this.version = version;
    try {
      const local = object(JSON.parse(readFileSync(this.localFile, 'utf8')), 'local settings');
      this.pools = readPoolPolicies(local.pools, this.localFile);
    } catch (error) {
      this.report(
        `Unable to reload pool policies from ${this.localFile}: ${error instanceof Error ? error.message : String(error)}; keeping the last valid pools`,
      );
    }
    return this.pools;
  }
}

/** Select a routed profile and pool using one clock reading and one pacing urgency per pool. */
export function choosePoolWithFallback(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: Parameters<typeof choosePool>[3] = {},
  urgency?: (pool: Pool, now: number) => number | undefined,
): { profile: Profile; pool: Pool } {
  const now = options.now ?? Date.now();
  const selection = { ...options, now };
  if (!urgency) return chooseByAllowance(profile, fallbacks, pools, readings, selection);

  const urgencyByPool = new Map<string, number | undefined>();
  return chooseByAllowance(profile, fallbacks, pools, readings, selection, (pool) => {
    if (!urgencyByPool.has(pool.name)) urgencyByPool.set(pool.name, urgency(pool, now));
    return urgencyByPool.get(pool.name);
  });
}
