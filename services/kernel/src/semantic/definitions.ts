import {
  publicationLimits,
  releaseAdmission,
  releaseDigest,
  validateRelease,
  type Release,
  type ReleaseViolation,
} from '@rezics/definitions';
import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { systemClock } from '../clock.ts';
import type { AccessCheck, AccountActor } from '../request/access.ts';
import activate from './definitions-activate.sql';
import pointer from './definitions-active.sql';
import exists from './definitions-exists.sql';
import publish from './definitions-publish.sql';
import read from './definitions-read.sql';
import { composedRelease, readComposedRelease } from './extensions.ts';

export const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const resource = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const releases = new Map<string, Release>();

export class DefinitionInputError extends Error {
  constructor(readonly violations: ReleaseViolation[]) {
    super('Invalid definition release');
  }
}
export class DefinitionAccessDeniedError extends Error {}
export class DefinitionNotFoundError extends Error {}
export class StaleEditorialHeadError extends Error {}

function validated(value: unknown): Release {
  const violations = validateRelease(value);
  if (violations.length) throw new DefinitionInputError(violations);
  return value as Release;
}

export function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** A cache hit reads the digest only. The cache stores validated, digest-checked bodies, and a release is immutable. */
export async function readRelease(
  pool: Pool | CommandTransaction,
  digest: string,
  options: { composed?: boolean } = {},
): Promise<Release | null> {
  if (DIGEST.exec(digest)?.[0] !== digest) return null;
  const composed = options.composed === false ? null : composedRelease(digest);
  if (composed) return composed;
  const cached = releases.get(digest);
  if (cached) return (await exists.run(pool, { route: resource.route, digest })) ? cached : null;
  const row = await read.run(pool, { route: resource.route, digest });
  if (!row) return options.composed === false ? null : readComposedRelease(pool, digest);
  const release = validated(row.body);
  if (releaseDigest(release) !== digest) throw new Error('Stored definition release digest mismatch');
  freeze(release);
  releases.set(digest, release);
  return release;
}

export async function activeRelease(
  pool: Pool | CommandTransaction,
): Promise<{ digest: string; head: number; release: Release } | null> {
  const active = await pointer.run(pool, { route: resource.route });
  if (!active) return null;
  const release = releases.get(active.digest) ?? (await readRelease(pool, active.digest));
  if (!release) throw new Error('Active definition release is missing');
  return { ...active, release };
}

export type WriteOptions = {
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  authorize: AccessCheck;
  authorization?: CommandAuthorization;
  deadline?: number;
  clock?: () => Date;
};

/** The command options of a definition write on `target`: Global's own partition unless a Context's extension is written. */
export function commandOptions(
  options: WriteOptions,
  kind: string,
  action: string,
  target: { partition: number; resource: { route: number; id: string } } = { partition: 0, resource },
) {
  return {
    partition: target.partition,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    receipt: {
      actorAccountId: options.actor.accountId,
      kind,
      key: options.idempotencyKey,
      digest: options.digest,
    },
    basis: {
      actorAccountId: options.actor.accountId,
      clientId: options.actor.clientId,
      requestedBy: options.actor.requestedBy,
    },
    authorization:
      options.authorization ??
      ({
        action,
        resource: target.resource,
        denied: () => new DefinitionAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!(await options.authorize(tx, attempt.time))) throw new DefinitionAccessDeniedError();
          return 'execute';
        },
      } satisfies CommandAuthorization),
    clock: options.clock,
  };
}

export async function publishRelease(pool: Pool, options: WriteOptions & { release: unknown }) {
  // A historical exemption is established by one indexed point on this same
  // pool, never a caller flag. JSON admission precedes digest work. Authorization
  // and receipt/key conflict ordering remain inside runCommand at fresh T.
  const caps = publicationLimits(options.release);
  let publishedDigest: string | undefined;
  let submitted = options.release;
  if (caps.length) {
    const admission = releaseAdmission(options.release);
    if (admission.length) throw new DefinitionInputError(admission);
    // The database await must retain owned data, not a mutable caller graph.
    submitted = structuredClone(options.release);
    publishedDigest = releaseDigest(submitted as Release);
    if (!(await exists.run(pool, { route: resource.route, digest: publishedDigest })))
      throw new DefinitionInputError(caps);
  }
  const release = validated(submitted);
  const digest = publishedDigest ?? releaseDigest(release);
  const command = await runCommand(
    pool,
    commandOptions(options, 'definitions.publish', 'definitions:publish'),
    async (tx, { transactionId }) => {
      const rows = await publish.run(tx, {
        route: resource.route,
        digest,
        body: release,
        transaction_id: transactionId,
      });
      return {
        value: { digest, created: rows !== null },
        events: [{ type: 'com.rezics.definitions.published.v1', subject: GLOBAL_CONTEXT, data: { digest } }],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

export async function activateRelease(
  pool: Pool,
  options: WriteOptions & { releaseDigest: string; expectedHead: number | null },
) {
  const command = await runCommand(
    pool,
    commandOptions(options, 'definitions.activate', 'definitions:activate'),
    async (tx, { transactionId }) => {
      const digest = options.releaseDigest;
      // This runs after command authorization and receipt lookup, even for a malformed digest.
      if (DIGEST.exec(digest)?.[0] !== digest || !(await read.run(tx, { route: resource.route, digest })))
        throw new DefinitionNotFoundError();
      const rows = await activate.run(tx, {
        route: resource.route,
        digest,
        expected_head: options.expectedHead ?? 0,
        transaction_id: transactionId,
      });
      if (!rows.length) throw new StaleEditorialHeadError();
      const head = rows[0]!.head;
      return {
        value: { digest, head },
        events: [{ type: 'com.rezics.definitions.activated.v1', subject: GLOBAL_CONTEXT, data: { digest, head } }],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

class AlreadyActive extends Error {
  constructor(readonly digest: string) {
    super('Definitions are already active');
  }
}

/** Trusted setup only: the first activation and its release commit together, without an actor. */
export async function bootstrapRelease(pool: Pool, release: Release, clock: () => Date = systemClock): Promise<string> {
  const existing = await pointer.run(pool, { route: resource.route });
  if (existing) return existing.digest;
  const caps = publicationLimits(release);
  if (caps.length) throw new DefinitionInputError(caps);
  const body = validated(release);
  const digest = releaseDigest(body);
  try {
    const command = await runCommand(pool, { partition: 0, clock }, async (tx, { transactionId }) => {
      const active = await pointer.run(tx, { route: resource.route });
      if (active) throw new AlreadyActive(active.digest);
      await publish.run(tx, { route: resource.route, digest, body, transaction_id: transactionId });
      const rows = await activate.run(tx, {
        route: resource.route,
        digest,
        expected_head: 0,
        transaction_id: transactionId,
      });
      if (!rows.length) throw new StaleEditorialHeadError();
      return {
        value: digest,
        events: [
          { type: 'com.rezics.definitions.published.v1', subject: GLOBAL_CONTEXT, data: { digest } },
          { type: 'com.rezics.definitions.activated.v1', subject: GLOBAL_CONTEXT, data: { digest, head: 1 } },
        ],
      };
    });
    return command.value;
  } catch (error) {
    if (error instanceof AlreadyActive) return error.digest;
    if (error instanceof StaleEditorialHeadError) {
      const active = await pointer.run(pool, { route: resource.route });
      if (active) return active.digest;
    }
    throw error;
  }
}
