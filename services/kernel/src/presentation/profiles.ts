import { profileDigest, type PresentationProfile } from '@rezics/composition';
import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { AccessCheck, AccountActor } from '../request/access.ts';
import { ProfileCache, profileSnapshot } from './profile-cache.ts';
import activate from './profiles-activate.sql';
import pointer from './profiles-active.sql';
import publish from './profiles-publish.sql';
import read from './profiles-read.sql';

const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const resource = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const profiles = new ProfileCache();

export { ProfileInputError } from './profile-cache.ts';
export class ProfileAccessDeniedError extends Error {}
export class ProfileNotFoundError extends Error {}
export class StaleProfileHeadError extends Error {}

/** Read existence from this database; only immutable, validated bodies are shared across pools. */
export async function readProfile(
  pool: Pool | CommandTransaction,
  digest: string,
): Promise<PresentationProfile | null> {
  if (DIGEST.exec(digest)?.[0] !== digest) return null;
  const row = await read.run(pool, { route: resource.route, digest });
  if (!row) return null;
  return profiles.read(digest, row.body);
}

export async function activeProfile(
  pool: Pool,
): Promise<{ digest: string; head: number; profile: PresentationProfile } | null> {
  const active = await pointer.run(pool, { route: resource.route });
  if (!active) return null;
  const profile = await readProfile(pool, active.digest);
  if (!profile) throw new Error('Active presentation profile is missing');
  return { ...active, profile };
}

type WriteOptions = {
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  authorize: AccessCheck;
  authorization?: CommandAuthorization;
  deadline?: number;
};

function commandOptions(options: WriteOptions, kind: string, action: string) {
  return {
    partition: 0,
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
        resource,
        denied: () => new ProfileAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!(await options.authorize(tx, attempt.time))) throw new ProfileAccessDeniedError();
          return 'execute';
        },
      } satisfies CommandAuthorization),
  };
}

export async function publishProfile(pool: Pool, options: WriteOptions & { profile: unknown }) {
  // Validate before runCommand can check out a connection, including for a replay.
  const profile = profileSnapshot(options.profile);
  const digest = profileDigest(profile);
  const command = await runCommand(
    pool,
    commandOptions(options, 'presentation.publish', 'presentation:publish'),
    async (tx, { transactionId }) => {
      const rows = await publish.run(tx, {
        route: resource.route,
        digest,
        body: profile,
        transaction_id: transactionId,
      });
      return {
        value: { digest, created: rows !== null },
        events: [{ type: 'com.rezics.presentation.profile.published.v1', subject: GLOBAL_CONTEXT, data: { digest } }],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

export async function activateProfile(
  pool: Pool,
  options: WriteOptions & { profileDigest: string; expectedHead: number | null },
) {
  const command = await runCommand(
    pool,
    commandOptions(options, 'presentation.activate', 'presentation:activate'),
    async (tx, { transactionId }) => {
      const digest = options.profileDigest;
      // This runs after command authorization and receipt lookup, even for a malformed digest.
      if (DIGEST.exec(digest)?.[0] !== digest || !(await read.run(tx, { route: resource.route, digest })))
        throw new ProfileNotFoundError();
      const rows = await activate.run(tx, {
        route: resource.route,
        digest,
        expected_head: options.expectedHead ?? 0,
        transaction_id: transactionId,
      });
      if (!rows.length) throw new StaleProfileHeadError();
      const head = rows[0]!.head;
      return {
        value: { digest, head },
        events: [
          { type: 'com.rezics.presentation.profile.activated.v1', subject: GLOBAL_CONTEXT, data: { digest, head } },
        ],
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
    super('A presentation profile is already active');
  }
}

/** Trusted setup only: the first activation and its profile commit together, without an actor. */
export async function bootstrapProfile(pool: Pool, profile: PresentationProfile): Promise<string> {
  const existing = await pointer.run(pool, { route: resource.route });
  if (existing) return existing.digest;
  const body = profileSnapshot(profile);
  const digest = profileDigest(body);
  try {
    const command = await runCommand(pool, { partition: 0 }, async (tx, { transactionId }) => {
      const active = await pointer.run(tx, { route: resource.route });
      if (active) throw new AlreadyActive(active.digest);
      await publish.run(tx, { route: resource.route, digest, body, transaction_id: transactionId });
      const rows = await activate.run(tx, {
        route: resource.route,
        digest,
        expected_head: 0,
        transaction_id: transactionId,
      });
      if (!rows.length) throw new StaleProfileHeadError();
      return {
        value: digest,
        events: [
          { type: 'com.rezics.presentation.profile.published.v1', subject: GLOBAL_CONTEXT, data: { digest } },
          {
            type: 'com.rezics.presentation.profile.activated.v1',
            subject: GLOBAL_CONTEXT,
            data: { digest, head: 1 },
          },
        ],
      };
    });
    return command.value;
  } catch (error) {
    if (error instanceof AlreadyActive) return error.digest;
    if (error instanceof StaleProfileHeadError) {
      const active = await pointer.run(pool, { route: resource.route });
      if (active) return active.digest;
    }
    throw error;
  }
}
