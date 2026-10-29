import { choosePool, choosePoolWithFallback as chooseByAllowance } from './allowance.ts';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool, PoolReading, Profile } from './types.ts';

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
function burnCeiling(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('invalid maxBurnPerHour');
  return value;
}

/** Parse only the pool section so a live reload cannot change other process settings. */
export function readPoolPolicies(value: unknown, localFile: string): Pool[] {
  if (!Array.isArray(value)) throw new Error('pools must be an array');
  const pools = value.map((raw: unknown) => {
    const pool = object(raw, 'pool');
    keys(
      pool,
      ['name', 'cli', 'classes', 'configDirectory', 'command', 'allowanceKey', 'usageFile', 'policy', 'note'],
      'pool',
    );
    if (pool.note !== undefined && typeof pool.note !== 'string') throw new Error('pool note must be text');
    if (!['codex', 'grok', 'cursor', 'claude'].includes(String(pool.cli))) throw new Error('unsupported pool CLI');
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
          : { reservePerHour: positive(policy.reservePerHour, 'reservePerHour') }),
        ...(policy.maxBurnPerHour === undefined ? {} : { maxBurnPerHour: burnCeiling(policy.maxBurnPerHour) }),
      },
    };
  });
  if (new Set(pools.map((p) => p.name)).size !== pools.length) throw new Error('duplicate pool name');
  return pools;
}

export class PoolPolicyReloader {
  private mtime: number | undefined;
  private pools: Pool[];
  private readonly initial: Pool[];
  private reported = false;
  constructor(
    private readonly localFile: string,
    initial: Pool[],
    private readonly report: (message: string) => void,
  ) {
    this.pools = initial;
    this.initial = initial;
    try {
      this.mtime = statSync(localFile).mtimeMs;
    } catch {
      /* first choice reports a missing file */
    }
  }
  read(): Pool[] {
    try {
      const mtime = statSync(this.localFile).mtimeMs;
      if (mtime === this.mtime) return this.pools;
      const local = JSON.parse(readFileSync(this.localFile, 'utf8')) as { pools?: unknown };
      const pools = readPoolPolicies(local?.pools ?? [], this.localFile);
      this.mtime = mtime;
      this.pools = pools;
    } catch (error) {
      this.pools = this.initial;
      if (!this.reported) {
        this.reported = true;
        this.report(
          `Unable to reload pool policies from ${this.localFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
