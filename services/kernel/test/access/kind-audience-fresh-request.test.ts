import { expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { AccessWorkAccounting } from '../../src/access/work.ts';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import type { PrepareKindAudienceInput } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

test('fresh authenticated Kind preparation rejects an Actor without the original Access identity before IO', async () => {
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  let io = 0;
  Object.defineProperty(pool, 'connect', {
    value() {
      io++;
      throw new Error('Forged Kind request reached checkout');
    },
  });
  Object.defineProperty(pool, 'query', {
    value() {
      io++;
      throw new Error('Forged Kind request reached query');
    },
  });
  const deadline = Date.now() + 5000;
  const work = new AccessWorkAccounting(
    {
      reserve() {
        io++;
        throw new Error('Forged Kind request reached accounting admission');
      },
    },
    deadline,
  );
  const actor = Object.freeze({
    kind: 'account' as const,
    accountId: newId(0xc100),
    clientId: 'copied-client',
    scopes: Object.freeze(['collection:read']),
    requestedBy: null,
    authnEpoch: 1,
  });
  const locator = Object.freeze({
    route: 0xc100,
    ownerAccountId: actor.accountId,
    collectionId: newId(0xc100),
    preparationId: crypto.randomUUID(),
  });
  const input: PrepareKindAudienceInput = {
    origin: { kind: 'collection-kind-audience-origin', locator, id: crypto.randomUUID() },
    input: { kind: 'collection-kind-audience-input', locator, id: crypto.randomUUID() },
    context: { pool, deadline },
    allowance: {
      reservationId: 'untrusted-request',
      remaining: {
        candidateKeys: 0,
        nativeRows: 0,
        identityMetadataRows: 0,
        emptySeeks: 0,
        nativePoints: 0,
        witnessKeys: 0,
        statements: 0,
        bytes: 0,
      },
    },
    request: {
      kind: 'authenticated',
      actor,
      context: { pool, deadline, work, time: Object.freeze({}) as AuthoritativeTime },
    },
  };

  try {
    const prepare = createAccess({ actions: new Map([['collection:read', { anonymous: false }]]) }).kindAudience
      ?.prepare;
    if (!prepare) throw new Error('Original Access factory omitted its Kind audience port');
    expect(prepare.bound(input)).toBeUndefined();
    await expect(prepare.run(input)).rejects.toMatchObject({
      dependency: 'Collection Kind audience original fresh request',
    });
    expect(io).toBe(0);
  } finally {
    await pool.end();
  }
});

test('Kind capture cannot fund a restored account original with a UUID reservation and a larger deadline', async () => {
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  let io = 0;
  Object.defineProperty(pool, 'connect', {
    value() {
      io++;
      throw new Error('Restored original reached native IO');
    },
  });
  const deadline = Date.now() + 5000;
  const work = new AccessWorkAccounting(
    {
      reserve() {
        io++;
        throw new Error('Restored original acquired a new allowance');
      },
    },
    deadline,
  );
  const actor = Object.freeze({
    kind: 'account' as const,
    accountId: newId(0xc100),
    clientId: 'restored',
    scopes: Object.freeze(['collection:read']),
    requestedBy: null,
    authnEpoch: 1,
  });
  const access = createAccess({ actions: new Map([['collection:read', { anonymous: true }]]) });
  const capture = access.kindAudience?.capture;
  if (!capture) throw new Error('Original Access omitted Kind capture');
  const input = {
    actor,
    locator: {
      route: 0xc100,
      ownerAccountId: actor.accountId,
      collectionId: newId(0xc100),
      preparationId: crypto.randomUUID(),
    },
    // An object carrying an old time shape is deliberately not original authentication.
    context: { pool, deadline: deadline + 1, work, time: Object.freeze({}) as AuthoritativeTime },
    allowance: {
      reservationId: crypto.randomUUID(),
      remaining: {
        candidateKeys: 100,
        nativeRows: 100,
        nativePoints: 100,
        identityMetadataRows: 100,
        witnessKeys: 100,
        emptySeeks: 100,
        statements: 100,
        bytes: 65536,
      },
    },
  };
  try {
    expect(capture.bound(input)).toBeUndefined();
    await expect(capture.run(input)).rejects.toMatchObject({
      dependency: 'Collection Kind audience actual native request origin',
    });
    expect(io).toBe(0);
  } finally {
    await pool.end();
  }
});
