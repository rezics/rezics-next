import { expect, expectTypeOf, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { AccessWorkAccounting } from '../../src/access/work.ts';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import type {
  CollectionKindPreparationLocator,
  CollectionKindWorkDefinition,
} from '../../src/library/collection-kind-work-admission.ts';
import type { WorkDimensions, WorkReceipt } from '../../src/library/collection-source.ts';
import type {
  Access,
  Actor,
  CaptureKindAudienceOriginInput,
  KindAudienceAccess,
  KindAudienceBinding,
  KindAudienceCoverage,
  KindAudienceEvidenceRef,
  KindAudienceOriginRef,
  KindAudienceWorkDeclaration,
  PrepareKindAudienceInput,
  PrepareKindAudienceResult,
  ResolveKindAudienceInput,
  VerifyKindAudienceSourceInput,
  VerifyKindAudienceSourceResult,
} from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import type { CollectionKindPreparationWorkContext } from '../../src/search/scope-work-context.ts';

// This contract case does not replace the deferred native positive/currentness
// scenarios in prepared-work, Kind preparation and Scope Kind acceptance.
test('Native Kind audience origin and current evidence have one original-evaluator contract without restored identity or technical work as permission', async () => {
  expectTypeOf<Access['kindAudience']>().toEqualTypeOf<KindAudienceAccess | undefined>();
  expectTypeOf<KindAudienceBinding>().toEqualTypeOf<
    Readonly<{ locator: CollectionKindPreparationLocator; definition: CollectionKindWorkDefinition }>
  >();
  expectTypeOf<CaptureKindAudienceOriginInput['actor']>().toEqualTypeOf<Actor>();
  expectTypeOf<
    Extract<keyof PrepareKindAudienceInput, 'actor' | 'jwt' | 'principal' | 'claims' | 'time' | 'tx' | 'work' | 'ids'>
  >().toEqualTypeOf<never>();
  expectTypeOf<keyof PrepareKindAudienceInput['context']>().toEqualTypeOf<'pool' | 'deadline'>();
  expectTypeOf<ResolveKindAudienceInput['work']>().toEqualTypeOf<CollectionKindPreparationWorkContext>();
  expectTypeOf<VerifyKindAudienceSourceInput['work']>().toEqualTypeOf<CollectionKindPreparationWorkContext>();
  expectTypeOf<KindAudienceWorkDeclaration['source']>().toEqualTypeOf<WorkDimensions>();
  expectTypeOf<Extract<PrepareKindAudienceResult, { status: 'prepared' }>['coverage']>().toEqualTypeOf<
    KindAudienceCoverage
  >();
  type Current = Extract<VerifyKindAudienceSourceResult, { status: 'current' }>;
  expectTypeOf<Current['coverage']>().toEqualTypeOf<KindAudienceCoverage>();
  expectTypeOf<Current['time']>().toEqualTypeOf<AuthoritativeTime>();
  expectTypeOf<Current['work']>().toEqualTypeOf<WorkReceipt>();
  expectTypeOf<Current['binding']>().toEqualTypeOf<KindAudienceBinding>();
  expectTypeOf<Extract<KindAudienceOriginRef | KindAudienceEvidenceRef, Actor>>().toEqualTypeOf<never>();
  expectTypeOf<keyof KindAudienceCoverage>().toEqualTypeOf<
    'formula' | 'negatives' | 'temporal' | 'typeDisclosure' | 'writers'
  >();

  const actor = Object.freeze({
    kind: 'account' as const,
    accountId: newId(0xc100),
    clientId: 'copied-client',
    scopes: Object.freeze(['subject:read']),
    requestedBy: null,
    authnEpoch: 1,
  });
  // Existing mocks remain valid and cannot acquire this port by implementing
  // ordinary authenticate/authorize or by returning an Actor-shaped object.
  const manual: Access = { authenticate: async () => actor, authorize: async () => true };
  expect(manual.kindAudience).toBeUndefined();
  const native = createAccess({ actions: new Map([['subject:read', { anonymous: true }]]) });
  const capture = native.kindAudience?.capture;
  if (!capture) throw new Error('Original factory omitted its native Kind seam');
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  let io = 0;
  Object.defineProperty(pool, 'connect', {
    value() {
      io++;
      throw new Error('Copied origin reached IO');
    },
  });
  Object.defineProperty(pool, 'query', {
    value() {
      io++;
      throw new Error('Copied origin reached IO');
    },
  });
  const deadline = Date.now() + 5000;
  const work = new AccessWorkAccounting(
    {
      reserve() {
        throw new Error('Copied origin reached accounting admission');
      },
    },
    deadline,
  );
  const input: CaptureKindAudienceOriginInput = {
    actor,
    locator: {
      route: 0xc100,
      ownerAccountId: actor.accountId,
      collectionId: newId(0xc100),
      preparationId: crypto.randomUUID(),
    },
    context: {
      pool,
      deadline,
      work,
      // @ts-expect-error A structural object is not a live native Core T either.
      time: Object.freeze({}),
    },
    allowance: {
      reservationId: 'untrusted-origin',
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
