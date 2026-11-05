import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { IdempotencyConflictError, commandTime, type CommandAttempt } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { ProfileCache, profileSnapshot } from '../../src/presentation/profile-cache.ts';
import {
  activateProfile,
  activeProfile,
  bootstrapProfile,
  publishProfile,
  readProfile,
  ProfileAccessDeniedError,
  ProfileInputError,
  ProfileNotFoundError,
  StaleProfileHeadError,
} from '../../src/presentation/profiles.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { testAccess } from '../support/test-kernel.ts';

// Native storage/receipt fixture; callback seams below test ownership, not permission policy.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
configureTestReceiptKeys(pool);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
const actor: AccountActor = {
  kind: 'account',
  accountId: newId(0),
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const options = (allowed = true) => ({
  actor,
  idempotencyKey: randomUUID(),
  digest: new Uint8Array(32).fill(4),
  authorize: async () => allowed,
});
const profile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'title', text, level: 2 } }] },
  bases: [],
  types: [],
  routes: [],
});
const props = (body: PresentationProfile) => (body.generic as CompositionDocument).content[0]!.props;
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await released;
    },
  };
}
async function counts() {
  return (
    await admin.query(`SELECT
    (SELECT count(*)::int FROM presentation.profile) AS profiles,
    (SELECT count(*)::int FROM presentation.profile_activation) AS heads,
    (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM core.outbox) AS events`)
  ).rows[0];
}

// This file starts with the genuinely empty migrated fixture, without SQL responders.
test('bootstrap captures before its pointer await, defers unused errors and preserves the concurrent winner', async () => {
  const sql = observeSql(pool);
  try {
    expect(await activeProfile(pool)).toBeNull();
    const statement = sql.records.find((r) => r.statement.includes('FROM presentation.profile_activation'))!.statement;
    const invalid = profile('<b>invalid original</b>');
    const heldInvalid = sql.hold({ statement }, 'after');
    const refused = bootstrapProfile(pool, invalid);
    // Attach rejection before releasing the native boundary.
    const rejection = expect(refused).rejects.toBeInstanceOf(ProfileInputError);
    try {
      await heldInvalid.entered;
      props(invalid).text = 'Valid replacement';
    } finally {
      heldInvalid.release();
    }
    await rejection;
    expect(await activeProfile(pool)).toBeNull();

    const loser = profile('Concurrent loser');
    const heldLoser = sql.hold({ statement }, 'after');
    const pendingLoser = bootstrapProfile(pool, loser);
    let winnerPending: Promise<string> | undefined;
    try {
      await heldLoser.entered;
      const original = profile('Original bootstrap');
      const expected = structuredClone(original);
      const heldWinner = sql.hold({ statement }, 'after');
      winnerPending = bootstrapProfile(pool, original);
      try {
        await heldWinner.entered;
        props(original).text = 'Changed during pointer read';
        original.routes.push({ route: '/changed', document: { root: { props: {} }, content: [] } });
      } finally {
        heldWinner.release();
      }
      expect(await winnerPending).toBe(profileDigest(expected));
      expect((await activeProfile(pool))!.profile).toEqual(expected);
      expect(Object.isFrozen(original)).toBe(false);
    } finally {
      heldLoser.release();
      await winnerPending;
    }
    expect(await pendingLoser).toBe((await activeProfile(pool))!.digest);
    expect((await counts()).profiles).toBe(1);
    expect((await counts()).heads).toBe(1);

    const before = await counts();
    const start = sql.records.length;
    const malformed = { format: PROFILE_FORMAT } as PresentationProfile;
    const heldActive = sql.hold({ statement }, 'after');
    const ignored = bootstrapProfile(pool, malformed);
    try {
      await heldActive.entered;
      Object.assign(malformed, profile('Unused replacement'));
    } finally {
      heldActive.release();
    }
    expect(await ignored).toBe((await activeProfile(pool))!.digest);
    // Read only the bootstrap's records, excluding the activeProfile assertion's two reads.
    expect(sql.records.slice(start, -2).map((r) => r.statement)).toEqual([statement]);
    expect(await counts()).toEqual(before);
    expect(await bootstrapProfile(pool, null as unknown as PresentationProfile)).toBe(await pendingLoser);
  } finally {
    await sql.close();
  }
});

test('activation retains its original digest and head across authorization', async () => {
  const original = profile('Original ');
  const replacement = profile('Replacement ');
  const a = await publishProfile(pool, { ...options(), profile: original });
  const b = await publishProfile(pool, { ...options(), profile: replacement });
  const prior = (await activeProfile(pool))!;
  const held = barrier();
  const input = {
    ...options(),
    profileDigest: a.digest,
    expectedHead: prior.head,
    authorize: async () => {
      await held.wait();
      return true;
    },
  };
  const pending = activateProfile(pool, input);
  try {
    await held.entered;
    input.profileDigest = b.digest;
    input.expectedHead = prior.head + 99;
  } finally {
    held.release();
  }
  const result = await pending;
  expect(result.digest).toBe(a.digest);
  expect(result.head).toBe(prior.head + 1);
  expect((await activeProfile(pool))!.digest).toBe(a.digest);
  expect(input.profileDigest).toBe(b.digest);
  expect(input.expectedHead).toBe(prior.head + 99);
});

test('original stale, malformed, missing and denied inputs cannot become valid replacements', async () => {
  const valid = await publishProfile(pool, { ...options(), profile: profile('Valid replacement') });
  for (const scenario of ['stale', 'malformed', 'missing', 'denied'] as const) {
    const prior = (await activeProfile(pool))!;
    const before = await counts();
    const held = barrier();
    const input = {
      ...options(),
      profileDigest:
        scenario === 'malformed' ? 'invalid' : scenario === 'missing' ? `sha256:${'0'.repeat(64)}` : valid.digest,
      expectedHead: scenario === 'stale' ? prior.head - 1 : prior.head,
      authorize: async () => {
        await held.wait();
        return scenario !== 'denied';
      },
    };
    const pending = activateProfile(pool, input);
    const rejected = expect(pending).rejects.toBeInstanceOf(
      scenario === 'stale'
        ? StaleProfileHeadError
        : scenario === 'denied'
          ? ProfileAccessDeniedError
          : ProfileNotFoundError,
    );
    try {
      await held.entered;
      input.profileDigest = valid.digest;
      input.expectedHead = prior.head;
      input.authorize = async () => true;
    } finally {
      held.release();
    }
    await rejected;
    expect(await counts()).toEqual(before);
    expect(await activeProfile(pool)).toEqual(prior);
  }
});

test('publish and activate keep the actual original callback while native checkout is pending', async () => {
  for (const kind of ['publish', 'activate'] as const) {
    for (const allowed of [true, false]) {
      const prior = (await activeProfile(pool))!;
      const original = profile(`Checkout ${kind} ${allowed}`);
      const target = await publishProfile(pool, { ...options(), profile: original });
      const held = barrier();
      const connect = pool.connect;
      const checkout: () => Promise<pg.PoolClient> = connect.bind(pool);
      let first = true;
      // Delegate every checkout to the real migrated pool; delay only the first call.
      pool.connect = (async () => {
        if (first) {
          first = false;
          await held.wait();
        }
        return checkout();
      }) as typeof pool.connect;
      let originalCalls = 0;
      let replacementCalls = 0;
      const input = {
        ...options(),
        profile: original,
        profileDigest: target.digest,
        expectedHead: prior.head,
        authorize: async () => {
          originalCalls++;
          return allowed;
        },
      };
      const before = await counts();
      const pending = kind === 'publish' ? publishProfile(pool, input) : activateProfile(pool, input);
      const settled = pending.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      try {
        await held.entered;
        input.authorize = async () => {
          replacementCalls++;
          return !allowed;
        };
        props(original).text = 'Changed at checkout';
      } finally {
        held.release();
        pool.connect = connect;
      }
      const result = await settled;
      expect(originalCalls).toBe(1);
      expect(replacementCalls).toBe(0);
      if (allowed) expect(result.value!.digest).toBe(target.digest);
      else {
        expect(result.error).toBeInstanceOf(ProfileAccessDeniedError);
        expect(await counts()).toEqual(before);
      }
    }
  }
});

test('authorized replay retains the original receipt binding and still authorizes, while a changed request conflicts', async () => {
  const body = profile('Replay custody');
  const target = await publishProfile(pool, { ...options(), profile: body });
  const replacement = await publishProfile(pool, { ...options(), profile: profile('Replay replacement') });
  const prior = (await activeProfile(pool))!;
  const input = { ...options(), profileDigest: target.digest, expectedHead: prior.head };
  const originalKey = input.idempotencyKey;
  const originalDigest = new Uint8Array(input.digest);
  const activated = await activateProfile(pool, input);
  const before = await counts();
  const held = barrier();
  let checks = 0;
  input.authorize = async () => {
    checks++;
    await held.wait();
    return true;
  };
  const replay = activateProfile(pool, input);
  try {
    await held.entered;
    input.profileDigest = 'malformed replacement';
    input.expectedHead = 0;
    input.idempotencyKey = randomUUID();
    input.digest.fill(9);
    input.actor = { ...actor, accountId: newId(0) };
  } finally {
    held.release();
  }
  expect(await replay).toEqual({ ...activated, replayed: true });
  expect(checks).toBe(1);
  expect(await counts()).toEqual(before);
  await expect(
    activateProfile(pool, {
      ...options(),
      idempotencyKey: originalKey,
      digest: new Uint8Array(32).fill(9),
      profileDigest: replacement.digest,
      expectedHead: prior.head,
    }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(
    activateProfile(pool, {
      ...options(false),
      idempotencyKey: originalKey,
      digest: originalDigest,
      profileDigest: target.digest,
      expectedHead: prior.head,
    }),
  ).rejects.toBeInstanceOf(ProfileAccessDeniedError);
  expect(await counts()).toEqual(before);

  const publishInput = { ...options(), profile: profile('Publish replay') };
  const published = await publishProfile(pool, publishInput);
  expect(await publishProfile(pool, publishInput)).toEqual({ ...published, replayed: true });
  await expect(
    publishProfile(pool, { ...publishInput, digest: new Uint8Array(32).fill(8), profile: profile('Changed digest') }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(publishProfile(pool, { ...publishInput, authorize: async () => false })).rejects.toBeInstanceOf(
    ProfileAccessDeniedError,
  );
});

test('retry rechecks authority and retains original publish body and activation scalars', async () => {
  for (const kind of ['publish', 'activate'] as const) {
    const body = profile(`Retry original ${kind}`);
    const expected = structuredClone(body);
    const target = await publishProfile(pool, { ...options(), profile: body });
    const prior = (await activeProfile(pool))!;
    let attempts = 0;
    let replacements = 0;
    const input = {
      ...options(),
      profile: body,
      profileDigest: target.digest,
      expectedHead: prior.head,
      authorize: async () => {
        attempts++;
        if (attempts === 1) {
          props(body).text = 'Retry replacement';
          input.profileDigest = 'invalid';
          input.expectedHead = prior.head + 50;
          input.authorize = async () => {
            replacements++;
            return false;
          };
          // Existing executor retry classification, after a genuine native transaction starts.
          throw Object.assign(new Error('injected serialization conflict'), { code: '40001' });
        }
        return true;
      },
    };
    const result = kind === 'publish' ? await publishProfile(pool, input) : await activateProfile(pool, input);
    expect(result.digest).toBe(target.digest);
    expect(attempts).toBe(2);
    expect(replacements).toBe(0);
    const stored = (await readProfile(pool, result.digest))!;
    expect(stored).toEqual(expected);
    expect(Object.isFrozen(props(stored))).toBe(true);
    expect(Object.isFrozen(body)).toBe(false);
    if (kind === 'activate') expect((await activeProfile(pool))!.head).toBe(prior.head + 1);
  }
});

test('concurrent invocations sharing an options object own independent bodies, callbacks and heads', async () => {
  const body = profile('Concurrent first');
  const expected = structuredClone(body);
  const held = barrier();
  const input = {
    ...options(),
    profile: body,
    authorize: async () => {
      await held.wait();
      return true;
    },
  };
  const first = publishProfile(pool, input);
  let second: ReturnType<typeof publishProfile> | undefined;
  try {
    await held.entered;
    props(body).text = 'Concurrent second';
    input.idempotencyKey = randomUUID();
    input.authorize = async () => true;
    second = publishProfile(pool, input);
    expect((await second).digest).toBe(profileDigest(body));
  } finally {
    held.release();
    await second;
  }
  expect((await first).digest).toBe(profileDigest(expected));
  expect(await readProfile(pool, (await first).digest)).toEqual(expected);

  const prior = (await activeProfile(pool))!;
  const gate = barrier();
  const activationInput = {
    ...options(),
    profileDigest: (await first).digest,
    expectedHead: prior.head,
    authorize: async () => {
      await gate.wait();
      return true;
    },
  };
  const firstActivation = activateProfile(pool, activationInput);
  let secondActivation: ReturnType<typeof activateProfile> | undefined;
  try {
    await gate.entered;
    activationInput.profileDigest = (await second!).digest;
    activationInput.expectedHead = prior.head + 1;
    activationInput.idempotencyKey = randomUUID();
    activationInput.authorize = async () => true;
    secondActivation = activateProfile(pool, activationInput);
    activationInput.profileDigest = 'Changed after both invocations';
    activationInput.expectedHead = 0;
  } finally {
    gate.release();
  }
  expect(await firstActivation).toMatchObject({ digest: (await first).digest, head: prior.head + 1 });
  expect(await secondActivation!).toMatchObject({ digest: (await second!).digest, head: prior.head + 2 });
});

test('profile ownership rejects accessors and serialization substitution before either validation or hashing', async () => {
  const before = await counts();
  let invoked = 0;
  const accessor = profile('Accessor');
  Object.defineProperty(props(accessor), 'text', {
    enumerable: true,
    get() {
      invoked++;
      return 'Changed';
    },
  });
  const serialized = profile('Serialization hook');
  Object.defineProperty(serialized, 'toJSON', {
    value() {
      invoked++;
      return profile('Substituted');
    },
  });
  for (const body of [accessor, serialized]) {
    expect(() => profileSnapshot(body)).toThrow(ProfileInputError);
    await expect(publishProfile(pool, { ...options(), profile: body })).rejects.toBeInstanceOf(ProfileInputError);
    const cache = new ProfileCache();
    expect(() => cache.read(profileDigest(profile('Unused')), body)).toThrow(ProfileInputError);
    expect(cache.retained).toEqual({ entries: 0, bytes: 0 });
  }
  expect(invoked).toBe(0);
  expect(await counts()).toEqual(before);
});

test('native prepared authorization retains its live object, same time and evidence after caller replacement', async () => {
  const actions = ['presentation:publish', 'presentation:activate'] as const;
  const fixture = await createRealAccess(admin, { curator: newId(0) }, actions);
  const resource = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of actions) await fixture.grant(resource, 'curator', action);
  const access = testAccess({
    pool,
    auth: fixture.auth,
    actions: new Map(actions.map((action) => [action, { anonymous: false }])),
  });
  const deadline = Date.now() + 30_000;
  const identity = await access.authenticate(fixture.bearer('curator'), { pool, deadline });
  if (identity.kind !== 'account') throw new Error('Expected native account authentication');
  for (const kind of ['publish', 'activate'] as const) {
    const body = profile(`Native prepared ${kind}`);
    const target = await publishProfile(pool, { ...options(), profile: body });
    const prior = (await activeProfile(pool))!;
    const native = await accessCommandAuthorization(
      access,
      identity,
      `presentation:${kind}`,
      resource,
      { pool, deadline },
      () => new ProfileAccessDeniedError(),
    );
    const prepare = native.prepare!;
    const authorize = native.authorize;
    const held = barrier();
    let proof: unknown;
    let time!: CommandAttempt['time'];
    let calls = 0;
    let preparations = 0;
    native.prepare = async function (attempt) {
      expect(this).toBe(native);
      preparations++;
      proof = await prepare.call(this, attempt);
      time = attempt.time;
      await held.wait();
      return proof;
    };
    native.authorize = async function (tx, attempt, evidence) {
      expect(this).toBe(native);
      expect(evidence).toBe(proof);
      expect(attempt.time).toBe(time);
      expect(commandTime(tx)).toBe(time);
      calls++;
      const mode = await authorize.call(this, tx, attempt, evidence);
      if (calls === 1) throw Object.assign(new Error('native authorization retry'), { code: '40001' });
      return mode;
    };
    const input = {
      ...options(),
      actor: identity,
      profile: body,
      profileDigest: target.digest,
      expectedHead: prior.head,
      authorization: native,
    };
    const pending = kind === 'publish' ? publishProfile(pool, input) : activateProfile(pool, input);
    try {
      await held.entered;
      input.authorization = {
        ...native,
        authorize: async () => {
          throw new Error('Substituted authority');
        },
      };
      input.authorize = async () => false;
      input.profileDigest = 'invalid replacement';
      input.expectedHead = prior.head + 100;
      props(body).text = 'Changed during native prepare';
    } finally {
      held.release();
    }
    expect((await pending).digest).toBe(target.digest);
    expect(calls).toBe(2);
    expect(preparations).toBe(2);
    await fixture.revoke(resource, 'curator', `presentation:${kind}`);
    await expect(
      kind === 'publish'
        ? publishProfile(pool, { ...input, authorization: native })
        : activateProfile(pool, { ...input, authorization: native }),
    ).rejects.toBeInstanceOf(ProfileAccessDeniedError);
  }
});
