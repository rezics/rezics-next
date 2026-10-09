import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import type { RateLimitFamily } from '../rate-limit/budgets.ts';
import {
  defaultPlatformOpenGroups,
  PLATFORM_OPEN_GROUPS,
  qaStackPlatformOpenGroups,
  readPlatformOpenGroups,
  type PlatformOpenGroups,
} from '../../infrastructure/platform-open-groups.ts';
import {
  PLATFORM_COST,
  PLATFORM_SCOPE,
  PlatformAccessUnavailable,
  readPlatformPermissions,
} from './platform-permissions.ts';

export { PLATFORM_OPEN_GROUPS, qaStackPlatformOpenGroups, readPlatformOpenGroups };
export type { PlatformOpenGroups };

export type Exposure = 'public' | `platform:${string}`;
export interface ExposureSummary {
  groups: string[];
  operations: string[];
  generation: string;
}
export interface ExposureDeclaration {
  exposure: Exposure;
  rateLimitFamily?: RateLimitFamily | 'read';
  bearer?: boolean | 'optional';
  idempotencyKey?: boolean;
}
export type ExposureDeclarations = Record<string, Record<string, ExposureDeclaration>>;
export class PlatformClosed extends Error {
  readonly code = 'platform_closed';
  constructor() {
    super('This capability is closed');
  }
}
export const anonymousPlatformAccess = (): ExposureSummary => ({
  groups: [],
  operations: [],
  generation: 'anonymous',
});

export function validExposure(value: unknown): value is Exposure {
  return (
    value === 'public' ||
    (typeof value === 'string' && /^platform:[a-z][a-z0-9-]{0,63}$/.test(value))
  );
}

/** See docs/development/platform-gates.md. `*` is every platform group. */
export function platformGroupOpened(
  exposure: Exposure | undefined,
  open: PlatformOpenGroups | undefined,
): boolean {
  if (!open || !exposure || exposure === 'public' || !validExposure(exposure)) return false;
  const group = exposure.slice('platform:'.length);
  return open === '*' || open.includes(group);
}

/** Missing declarations always deny, even an individually granted operation. */
export function exposureAllows(
  exposure: Exposure | undefined,
  operationId: string,
  summary: ExposureSummary,
): boolean {
  return (
    exposure === 'public' ||
    (!!exposure &&
      validExposure(exposure) &&
      (summary.groups.includes(exposure.slice('platform:'.length)) ||
        summary.operations.includes(operationId)))
  );
}

interface CachedSummary {
  version: string;
  expiresAt: number;
  summary: ExposureSummary;
}
export class AccessExposure {
  private readonly cache = new Map<string, CachedSummary>();
  private readonly openGroups: PlatformOpenGroups | undefined;
  /** An explicit environment, including an empty value, stays closed and does
   * not consult the QA stack file. The default follows the process, then that file. */
  constructor(private readonly pool: Pool, env?: NodeJS.ProcessEnv) {
    this.openGroups = env ? readPlatformOpenGroups(env) : defaultPlatformOpenGroups();
  }

  groupOpened(exposure: Exposure | undefined): boolean {
    return platformGroupOpened(exposure, this.openGroups);
  }

  /** One exact principal/generation read on a cache hit. Misses read only the
   * bounded platform grants, and expire at the earliest grant deadline. */
  async summary(principal?: VerifiedPrincipal): Promise<ExposureSummary> {
    if (!principal) return anonymousPlatformAccess();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${PLATFORM_COST.statementMs}ms'`);
      const identity = (
        await client.query<{
          id: string;
          enforcement_epoch: string;
          authority_epoch: string;
          read_at: Date;
        }>(
          `
        SELECT p.id,p.enforcement_epoch,g.authority_epoch,clock_timestamp() AS read_at FROM access.principal p
        CROSS JOIN access.scope_gate g WHERE p.account_issuer = $1 AND p.account_subject = $2
          AND p.active AND g.id = $3 AND g.open AND g.dispatch_open`,
          [principal.issuer, principal.subject, PLATFORM_SCOPE],
        )
      ).rows[0];
      if (!identity) {
        await client.query('COMMIT');
        return anonymousPlatformAccess();
      }
      const version = `${identity.enforcement_epoch}:${identity.authority_epoch}`;
      const cached = this.cache.get(identity.id);
      if (cached?.version === version && cached.expiresAt > identity.read_at.getTime()) {
        await client.query('COMMIT');
        return structuredClone(cached.summary);
      }
      const permissions = await readPlatformPermissions(client, identity.id);
      const use = [
        ...new Set(
          permissions
            .map((p) => p.action)
            .filter((action) => action.startsWith('platform:use:'))
            .map((action) => action.slice('platform:use:'.length)),
        ),
      ].sort();
      const groups = use.filter((value) => /^[a-z][a-z0-9-]*$/.test(value));
      const operations = use.filter((value) => !groups.includes(value));
      if (operations.length > PLATFORM_COST.operations)
        throw new PlatformAccessUnavailable('Platform operation budget exceeded');
      const summary = {
        groups,
        operations,
        generation: createHash('sha256')
          .update(
            JSON.stringify([version, permissions.map((p) => [p.id, p.generation, p.witness])]),
          )
          .digest('hex'),
      };
      const expiresAt = Math.min(
        ...permissions.flatMap((p) => (p.valid_until ? [p.valid_until.getTime()] : [])),
        identity.read_at.getTime() + 60_000,
      );
      await client.query('COMMIT');
      if (this.cache.size >= PLATFORM_COST.cacheEntries)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(identity.id, { version, expiresAt, summary });
      return structuredClone(summary);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof PlatformAccessUnavailable) throw error;
      throw new PlatformAccessUnavailable('Platform access is unavailable');
    } finally {
      client.release();
    }
  }

  async require(
    principal: VerifiedPrincipal | undefined,
    exposure: Exposure | undefined,
    operationId: string,
  ): Promise<void> {
    if (exposure === 'public' || this.groupOpened(exposure)) return;
    if (!exposure || !exposureAllows(exposure, operationId, await this.summary(principal)))
      throw new PlatformClosed();
  }
}

export type PlatformGate = {
  require: AccessExposure['require'];
  groupOpened?: AccessExposure['groupOpened'];
};

/** Called after the owner resolves a template, profile, command, source or block.
 * The owner supplies its selected capability; HTTP body fields never select it.
 * An operation-specific grant can open that operation's selected capability. */
export async function requireSelectedPlatformCapability(
  owner: PlatformGate | undefined,
  principal: VerifiedPrincipal | undefined,
  selected: { exposure: Exposure; operationId: string },
): Promise<void> {
  if (selected.exposure === 'public') return;
  if (owner?.groupOpened?.(selected.exposure)) return;
  // Route tests that never construct an exposure owner still follow the stack
  // setting. An owner that exists decides from its own groups.
  if (!owner) {
    if (platformGroupOpened(selected.exposure, defaultPlatformOpenGroups())) return;
    throw new PlatformClosed();
  }
  await owner.require(principal, selected.exposure, selected.operationId);
}
