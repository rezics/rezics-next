import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'bun:test';
import { installIdentityRatingRepairProducer } from '../../../src/composition/identity-rating-repair.ts';
import { IDENTITY_REPAIR_MEMBERSHIP_CAP } from '../../../src/rating/identity-repair-bounds.ts';
import { createNativeRatingCapabilities, createRatingModule } from '../../../src/rating/module.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import type { IdentityRepairPage, IdentityWorkRef } from '../../../src/rating/identity-work-frame.ts';
import type { AccountActor } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { readIdentityMappings } from '../../../src/semantic/identity-epoch-read.ts';
import { stepIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap.ts';
import { home, seedLegacyRoot } from '../../semantic/support/identity-epoch.ts';
import {
  historicalEdge,
  isolatedDeployment,
  settle,
  type Deployment,
} from '../../semantic/support/identity-terminal-closure.ts';
import { createRealAccess, type RealAccessFixture } from '../../semantic/real-access.ts';
import { configureTestReceiptKeys } from '../../support/receipt-keys.ts';

export const IDENTITY_REPAIR_NATIVE_ROUTE = 0x7230;
export const IDENTITY_REPAIR_FOREIGN_ROUTE = 0x1110;
export const IDENTITY_REPAIR_NATIVE_AT = '2026-11-07T08:00:00.000000Z';

const tokens = {
  current: 1,
  keys: new Map([[1, new Uint8Array(32).fill(23)]]),
};
const routeKey = new Uint8Array(32).fill(31);
const actions = ['rating:vote', 'subject:read'] as const;

export type IdentityRepairNativePools = Readonly<{ pool: Pool; admin: Pool }>;
export type IdentityRepairNativeHost = Awaited<ReturnType<typeof openIdentityRepairNative>>;

export async function settleMapped(db: IdentityRepairNativePools, ids: readonly string[], rounds = 128) {
  const homes = [...new Set(ids.map(home))];
  let mappings = await readIdentityMappings(db.pool, [...ids]);
  for (let round = 0; round < rounds && mappings.some((mapping) => mapping.state !== 'mapped'); round++) {
    for (const partition of homes) {
      const progress = await stepIdentityEpochBootstrap(db.pool, partition);
      expect(progress.native.partition).toBe(partition);
    }
    mappings = await readIdentityMappings(db.pool, [...ids]);
  }
  const unfinished = mappings.filter((mapping) => mapping.state !== 'mapped');
  if (unfinished.length) throw new Error(`identity mappings did not settle (${unfinished.length})`);
  return mappings.map((mapping) => {
    if (mapping.state !== 'mapped') throw new Error('expected mapped identity');
    return mapping;
  });
}

export function laterIdentity(after: string, route = IDENTITY_REPAIR_NATIVE_ROUTE): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = newId(route);
    if (id > after) return id;
  }
  throw new Error('could not allocate a later identity key');
}

export function laterIdentities(after: string, count: number, route = IDENTITY_REPAIR_NATIVE_ROUTE): string[] {
  const ids: string[] = [];
  let cursor = after;
  for (let index = 0; index < count; index++) {
    const id = laterIdentity(cursor, route);
    ids.push(id);
    cursor = id;
  }
  return ids;
}

export async function openIdentityRepairNative(
  options: {
    identities?: number | undefined;
    redirectIndexes?: readonly number[] | undefined;
    foreignIndexes?: readonly number[] | undefined;
    memberships?: number | undefined;
    database?: (IdentityRepairNativePools & { close?: () => Promise<void> }) | undefined;
  } = {},
) {
  installIdentityRatingRepairProducer();
  const owned = options.database ? null : await isolatedDeployment();
  const db = options.database ?? owned!;
  configureTestReceiptKeys(db.pool);
  const route = IDENTITY_REPAIR_NATIVE_ROUTE;
  const count = Math.max(1, options.identities ?? 4);
  const originals: string[] = [];
  const foreign = new Set(options.foreignIndexes ?? []);
  for (let index = 0; index < count; index++) {
    originals.push(await seedLegacyRoot(db, foreign.has(index) ? IDENTITY_REPAIR_FOREIGN_ROUTE : route));
  }
  const root = originals.find((id, index) => !foreign.has(index)) ?? originals[0]!;
  for (const index of options.redirectIndexes ?? []) {
    const original = originals[index];
    if (!original || original === root) continue;
    await historicalEdge(db as Deployment, original, root);
  }
  if (owned) await owned.install();
  const local = originals.filter((id, index) => !foreign.has(index));
  const settled = await settle(db as Deployment, local, root);
  expect(settled.observed).toMatchObject({ state: 'mapped', original: root });
  const mappings = await settleMapped(db, originals);
  const byOriginal = new Map(mappings.map((mapping) => [mapping.original, mapping] as const));
  const accounts = {
    voter: newId(route),
    stranger: newId(route),
    outsider: newId(IDENTITY_REPAIR_FOREIGN_ROUTE),
  };
  const access = await createRealAccess(db.admin, accounts, [...actions]);
  const applicationAccess = access.access({
    actions: new Map(actions.map((action) => [action, { anonymous: action === 'subject:read' }])),
  });
  const capabilities = createNativeRatingCapabilities();
  const rating = createRatingModule({ pool: db.pool, capabilities });
  const application = rating.application({
    access: applicationAccess,
    tokens,
    routeKey,
  });
  async function actor(persona: keyof typeof accounts = 'voter'): Promise<AccountActor> {
    const authenticated = await applicationAccess.authenticate(access.bearer(persona), {
      pool: db.pool,
      deadline: Date.now() + 30_000,
    });
    if (authenticated.kind !== 'account') throw new Error('expected account actor');
    return authenticated;
  }
  async function seedVote(
    voter: AccountActor,
    targetId: string,
    units: number | null = 7,
    at = IDENTITY_REPAIR_NATIVE_AT,
  ) {
    await db.admin.query(
      `INSERT INTO rating.vote
        (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [route, voter.accountId, STANDARD_QUESTION_ID, targetId, units, at, newId(route)],
    );
  }
  async function seedMemberships(voter: AccountActor, count = IDENTITY_REPAIR_MEMBERSHIP_CAP) {
    const ids = Array.from({ length: count }, () => newId(route));
    await db.admin.query(
      `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
       SELECT $1, $2, id, $3::timestamptz, 'counted' FROM unnest($4::uuid[]) id`,
      [route, voter.accountId, IDENTITY_REPAIR_NATIVE_AT, ids],
    );
    return ids;
  }
  const commands = application.identityRepair;
  const read = application.identityRepairRead;
  const key = () => randomUUID();
  async function admit(voter: AccountActor, expectedGeneration: string | null = null): Promise<IdentityWorkRef> {
    const result = (await commands.admit(voter, { workId: newId(route), expectedGeneration }, key())).value;
    if (result.status !== 'admitted') throw new Error(result.reason);
    return { workId: result.frame.workId, generation: result.frame.generation };
  }
  async function select(voter: AccountActor, ref: IdentityWorkRef): Promise<IdentityRepairPage> {
    const result = (await commands.select(voter, ref, key())).value;
    if (result.status !== 'selected') throw new Error(result.reason);
    return result.page;
  }
  const binding = (page: IdentityRepairPage) => ({
    workId: page.workId,
    generation: page.generation,
    pageId: page.pageId,
    digest: page.digest,
  });
  const memberships = options.memberships;
  return {
    db,
    route,
    partition: partitionOf(route),
    foreignPartition: partitionOf(IDENTITY_REPAIR_FOREIGN_ROUTE),
    root,
    originals,
    foreignOriginals: originals.filter((_, index) => foreign.has(index)),
    mappings: byOriginal,
    terminal: (original: string) => {
      const mapping = byOriginal.get(original);
      if (!mapping) throw new Error(`missing mapping for ${original}`);
      return mapping.terminal;
    },
    epoch: (original: string) => {
      const mapping = byOriginal.get(original);
      if (!mapping) throw new Error(`missing mapping for ${original}`);
      return mapping.epoch.toString();
    },
    accounts,
    access: access as RealAccessFixture<'voter' | 'stranger' | 'outsider'>,
    rating,
    commands,
    read,
    actor,
    seedVote,
    seedMemberships,
    admit,
    select,
    binding,
    key,
    async close() {
      if (owned) await owned.close();
      else await options.database?.close?.();
    },
    async withMemberships(voter: AccountActor) {
      if (memberships === 0) return [];
      return seedMemberships(voter, memberships ?? IDENTITY_REPAIR_MEMBERSHIP_CAP);
    },
  };
}

export { home, routeOf };
