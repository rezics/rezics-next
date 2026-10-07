import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  AdmissionDenied,
  type ClaimedAdmission,
  type GraphTerminalProof,
  type RegisteredAdmission,
} from '../src/modules/access/admission.ts';
import type { RealmPermit } from '../src/modules/access/realm-management-policy.ts';
import {
  RealmReplyUnavailable,
  type PlacementInput,
  type PlacementPreparation,
} from '../src/modules/realm-reply/content-store.ts';
import { replyReceiptIri, type ReplyGraphReceipt } from '../src/modules/realm-reply/graph.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const id = (value: number) => `https://rezics.com/id/${uuid(value)}`;
const principal = { issuer: 'account', subject: 'reader' };
const realm = id(1),
  actor = id(2),
  reply = id(3),
  epoch = uuid(4);
const digest = 'a'.repeat(64);
const admission: RegisteredAdmission = {
  id: uuid(5),
  principalId: uuid(6),
  actingSubject: actor,
  authorityPath: 'represented-agent',
  action: 'reply.place',
  scope: `reply:place:${realm}`,
  idempotencyKey: 'place',
  requestDigest: digest,
  authorityEpoch: '7',
  registeredAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  state: 'registered',
  dispatchEligible: true,
  replayed: false,
};
const input: PlacementInput = {
  realm,
  reply,
  revisionId: uuid(8),
  revisionDigest: 'b'.repeat(64),
  reviewDecisionId: uuid(9),
  expectedHead: null,
};

function claimFence(withdrawn = false) {
  const statements: string[] = [];
  let releases = 0;
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      let rows: unknown[];
      if (sql.includes('FROM access.recovery_fence')) rows = [{ open: true, generation: '1' }];
      else if (sql.includes('SELECT scope_id, action FROM access.admission'))
        rows = [{ scope_id: admission.scope, action: admission.action }];
      else if (sql.includes('FROM access.scope_gate'))
        rows = [{ authority_epoch: '7', open: true, dispatch_open: true }];
      else if (sql.includes('FROM access.admission a'))
        rows = [
          {
            authority_witness: withdrawn
              ? [{ table: 'permission_grant', id: uuid(15), generation: '1' }]
              : null,
            topology: false,
            eligible: true,
          },
        ];
      else if (sql.includes('FROM access.permission_grant')) rows = [];
      else if (sql.includes('FROM access.admission WHERE id = $1 FOR UPDATE'))
        rows = [{ ...admission, scope_id: admission.scope, eligible: true }];
      else throw new Error(`Unexpected admission probe: ${sql}`);
      return { rows, rowCount: rows.length };
    },
    release: () => {
      releases++;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: async () => {
      throw new Error('Fence must reuse its caller client');
    },
  } as unknown as Pool;
  return {
    registry: new AccessAdmissionRegistry(pool),
    client,
    statements,
    releases: () => releases,
  };
}

test('a held-client fence refuses an unclaimed admission without owning the transaction or writing a claim', async () => {
  const f = claimFence();
  await expect(f.registry.fenceClaim(f.client, admission.id, digest, principal)).rejects.toThrow(
    'independently committed claim',
  );
  expect(f.releases()).toBe(0);
  expect(
    f.statements.some((sql) =>
      /^\s*(?:BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)\b/i.test(sql),
    ),
  ).toBe(false);
});

test('the held-client fence runs the selected-source validator instead of treating a Realm permit as authority', async () => {
  const f = claimFence(true);
  await expect(f.registry.fenceClaim(f.client, admission.id, digest, principal)).rejects.toThrow(
    'selected authority changed before dispatch',
  );
  expect(f.statements.some((sql) => sql.includes('FROM access.permission_grant'))).toBe(true);
  expect(
    f.statements.some((sql) =>
      /^\s*(?:BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)\b/i.test(sql),
    ),
  ).toBe(false);
  expect(f.releases()).toBe(0);
});

function placement(
  options: {
    prepared?: boolean;
    deny?: boolean;
    unknown?: boolean;
    terminal?: boolean;
    initialDeny?: boolean;
  } = {},
) {
  const events: string[] = [];
  let held = false,
    fences = 0;
  let durableState: RegisteredAdmission['state'] = options.terminal
    ? 'sealed'
    : options.prepared
      ? 'claimed'
      : 'registered';
  const claimedAt = new Date().toISOString();
  const preparation: PlacementPreparation = {
    operationId: admission.id,
    realm,
    reply,
    revisionId: input.revisionId,
    revisionDigest: input.revisionDigest,
    reviewDecisionId: input.reviewDecisionId!,
    reviewGeneration: '1',
    reviewDigest: 'c'.repeat(64),
    author: actor,
    ownerDataEpoch: epoch,
    ownerSequence: '1',
    rootTarget: id(10),
    rootRevision: id(11),
    parentReply: null,
    parentRevision: null,
    contextRevision: null,
    replayed: !!options.prepared,
  };
  let prepared: PlacementPreparation | null = options.prepared ? preparation : null;
  const proof = (outcome: 'succeeded' | 'cancelled', placementId?: string): ReplyGraphReceipt => ({
    admissionId: admission.id,
    requestDigest: digest,
    authorityEpoch: admission.authorityEpoch,
    scope: admission.scope,
    receipt: replyReceiptIri(admission),
    outcome,
    dataEpoch: epoch,
    sequence: '2',
    ...(placementId
      ? { placement: placementId, revisionId: input.revisionId, realm, reply, predecessor: null }
      : {}),
  });
  let terminal: ReplyGraphReceipt | null = options.terminal ? proof('succeeded', id(12)) : null;
  const permit: RealmPermit = {
    visibility: 'public',
    reviewMode: 'mandatory',
    member: true,
    revision: 'urn:rezics:realm-policy:policy',
    stamp: 'current',
    historyFloor: null,
  };
  const client = {} as PoolClient;
  const snapshot = (): RegisteredAdmission => ({
    ...admission,
    state: durableState,
    dispatchEligible: !terminal,
    replayed: durableState !== 'registered',
  });
  const assertNativeAuthority = () => {
    expect(durableState).toBe('claimed');
    expect(held).toBe(true);
    expect(fences).toBeGreaterThan(0);
  };
  const access = {
    register: async () => {
      expect(held).toBe(false);
      events.push('register.commit');
      return snapshot();
    },
    claim: async (): Promise<ClaimedAdmission> => {
      expect(held).toBe(false);
      if (options.initialDeny)
        throw new AdmissionDenied('selected authority changed before dispatch');
      durableState = 'claimed';
      events.push('claim.commit');
      return { ...snapshot(), state: 'claimed', claimedAt };
    },
    fenceClaim: async (borrowed: PoolClient, admissionId: string, requestDigest: string) => {
      expect(borrowed).toBe(client);
      expect(held).toBe(true);
      expect([admissionId, requestDigest]).toEqual([admission.id, digest]);
      expect(durableState).toBe('claimed');
      fences++;
      events.push('fence');
      if (options.deny) throw new AdmissionDenied('selected authority changed before dispatch');
      return { ...snapshot(), state: 'claimed' as const, claimedAt };
    },
    withRealmPolicy: async (
      _principal: unknown,
      _actor: string,
      _realm: string,
      _purpose: string,
      operation: (permit: RealmPermit, client?: PoolClient) => Promise<unknown>,
    ) => {
      expect(durableState).toBe('claimed');
      expect(held).toBe(false);
      held = true;
      events.push('permit.enter');
      try {
        return await operation(permit, client);
      } finally {
        held = false;
        events.push('permit.release');
      }
    },
    recordGraphOutcome: async (admissionId: string, received: GraphTerminalProof) => {
      expect(held).toBe(false);
      expect(admissionId).toBe(admission.id);
      expect(received).toMatchObject(terminal!);
      durableState = 'sealed';
      events.push('seal');
    },
  };
  const content = {
    hasReceipt: async () => prepared !== null,
    readPlacement: async () => prepared,
    preparePlacement: async (registered: RegisteredAdmission) => {
      assertNativeAuthority();
      expect(registered.state).toBe('claimed');
      events.push('prepare');
      prepared = preparation;
      return prepared;
    },
  };
  const contentCore = {
    settlePublication: async (
      _key: string,
      preparationId: string,
      settlement: { outcome: string; receipt: string },
    ) => {
      expect(preparationId).toBe(admission.id);
      expect(terminal).not.toBeNull();
      expect(settlement).toMatchObject({
        outcome: terminal!.outcome === 'succeeded' ? 'active' : 'rejected',
        receipt: terminal!.receipt,
      });
      events.push('settle');
    },
  };
  const bindings = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { type: 'literal' as const, value }]),
    );
  const graph = {
    query: async (sql: string) => {
      if (sql.includes('?outcome ?digest ?id')) {
        return {
          results: {
            bindings: terminal
              ? [
                  bindings({
                    outcome: `${RV}${terminal.outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`,
                    digest,
                    id: admission.id,
                    epoch: admission.authorityEpoch,
                    scope: admission.scope,
                    dataEpoch: epoch,
                    sequence: terminal.sequence,
                    ...(terminal.placement
                      ? {
                          placement: terminal.placement,
                          revision: `urn:rezics:content:revision:${input.revisionId}`,
                          realm,
                          reply,
                        }
                      : {}),
                  }),
                ]
              : [],
          },
        };
      }
      if (sql.includes('SELECT ?space ?realmRevision'))
        return {
          results: {
            bindings: [
              bindings({
                space: id(13),
                visibility: 'public',
                mode: 'mandatory',
                disclosure: `${RV}Public`,
                head: permit.revision!,
              }),
            ],
          },
        };
      if (/SELECT\s+\?placement/.test(sql)) return { results: { bindings: [] } };
      if (sql.includes('ASK'))
        return { boolean: !sql.includes('rv:rejectionKind rv:InvalidProfile') };
      throw new Error(`Unexpected Realm graph read: ${sql}`);
    },
    commandHealth: async () => ({
      profiles: {
        'realm-reply-placement-v1': profileRegistry['realm-reply-placement-v1'].sha256,
      },
    }),
    commandWithReceipt: async (envelope: CommandEnvelope) => {
      if (envelope.validations.length) {
        assertNativeAuthority();
        events.push('graph.place');
        if (options.unknown) throw new Error('graph transport failed without a receipt');
        terminal = proof('succeeded', envelope.validations[0]!.binding!.placement!);
      } else {
        expect(envelope.update).toContain('rv:outcome rv:Cancelled');
        events.push('graph.cancel');
        terminal ??= proof('cancelled');
      }
      return {
        status: 'committed',
        position: { datasetId: 'product', dataEpoch: epoch, sequence: '2' },
      };
    },
  };
  const env = {
    fuseki: graph,
    lineage: { dataEpoch: epoch, routingEpoch: uuid(14) },
    objectDirectory: '.temp/realm-write-pool',
  } as unknown as WorkActivationEnvironment;
  const store = new RealmReplyStore(
    content as unknown as ConstructorParameters<typeof RealmReplyStore>[0],
    contentCore as unknown as ConstructorParameters<typeof RealmReplyStore>[1],
    access as unknown as ConstructorParameters<typeof RealmReplyStore>[2],
    env,
  );
  return { store, events, terminal: () => terminal, state: () => durableState, held: () => held };
}

test('Realm placement commits registration and claim before preparation, then fences both native effects on its held client', async () => {
  const f = placement();
  const result = await f.store.place(principal, actor, input, admission.idempotencyKey, digest);
  expect(result).toMatchObject({ realm, reply, revisionId: input.revisionId });
  expect(f.events).toEqual([
    'register.commit',
    'claim.commit',
    'permit.enter',
    'fence',
    'prepare',
    'fence',
    'graph.place',
    'settle',
    'permit.release',
    'seal',
  ]);
  expect(f.state()).toBe('sealed');
  expect(f.held()).toBe(false);
});

test('withdrawal after registration resolves exact cancellation and sealing before a Realm callback can dispatch', async () => {
  const f = placement({ initialDeny: true });
  await expect(
    f.store.place(principal, actor, input, admission.idempotencyKey, digest),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  expect(f.events).toEqual(['register.commit', 'graph.cancel', 'seal']);
  expect(f.state()).toBe('sealed');
  expect(f.held()).toBe(false);
});

test.each([false, true])(
  'withdrawn authority cannot dispatch a Realm placement, including prepared=%s',
  async (prepared) => {
    const f = placement({ prepared, deny: true });
    await expect(
      f.store.place(principal, actor, input, admission.idempotencyKey, digest),
    ).rejects.toBeInstanceOf(AdmissionDenied);
    expect(f.events).not.toContain('prepare');
    expect(f.events).not.toContain('graph.place');
    expect(f.events).toContain('fence');
    expect(f.events).toContain('graph.cancel');
    expect(f.events.indexOf('seal')).toBeGreaterThan(f.events.indexOf('permit.release'));
    expect(f.terminal()?.outcome).toBe('cancelled');
    expect(f.state()).toBe('sealed');
  },
);

test('unknown Realm graph outcomes remain pending without a fabricated cancellation or Access seal', async () => {
  const f = placement({ prepared: true, unknown: true });
  await expect(
    f.store.place(principal, actor, input, admission.idempotencyKey, digest),
  ).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect(f.events).toContain('graph.place');
  expect(f.events).not.toContain('graph.cancel');
  expect(f.events).not.toContain('seal');
  expect(f.events).not.toContain('settle');
  expect(f.terminal()).toBeNull();
  expect(f.state()).toBe('claimed');
  expect(f.held()).toBe(false);
});

test('an exact terminal placement replays settlement and sealing without requesting new dispatch authority', async () => {
  const f = placement({ prepared: true, terminal: true, deny: true });
  expect(
    await f.store.place(principal, actor, input, admission.idempotencyKey, digest),
  ).toMatchObject({ realm, reply, replayed: true });
  expect(f.events).toEqual(['register.commit', 'settle', 'seal']);
  expect(f.state()).toBe('sealed');
});
