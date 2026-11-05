/** Private Kind controls. Persisted hashes and references never authorize a read. */
import { createHash } from 'node:crypto';
import type {
  AccessContext,
  Actor,
  PrepareReadDecisionsInput,
  ReadDecisions,
  ReadDecisionEligibility,
} from '../request/access.ts';
import type {
  KindAudienceAccess,
  KindAudienceOperation,
  KindAudienceWorkDeclaration,
  KindAudienceFreshRequest,
} from './kind-audience.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import type { CollectionKindPreparationLocator } from '../library/collection-kind-work-admission.ts';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import { authoritativeTimeValue, commandTime, type AuthoritativeTime } from '../command/command.ts';
import { currentOperationalResources, hasOperationalAdmission } from '../command/operational.ts';
import { collectionKindPreparationNativeWork } from '../search/scope-work-context.ts';
import { deadlineClient } from './authenticate.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { requireAccessDeadline } from '../request/unavailable.ts';
import { AccessWorkUnavailableError, EMPTY_ACCESS_WORK, type AccessWork, type AccessWorkAccounting } from './work.ts';
import { routeOf } from '../route/route.ts';
import originRead from './kind-audience-origin.sql';
import insertOrigin from './kind-audience-origin-insert.sql';
import lookupOrigin from './kind-audience-origin-read.sql';
import readCommittedInput from './kind-audience-input-read.sql';
import {
  collectionKindInputWork,
  resolveCollectionKindRawInput,
  type CollectionKindRawInputBody,
} from '../library/collection-kind-input.ts';

export type KindOriginalIdentity = Readonly<{ expires: number; account: unknown }>;
export type KindOriginalProducer = (actor: Actor, context: AccessContext) => KindOriginalIdentity | undefined;
type Original = Readonly<{ audience: string; digest: string; expires: number; deadline: number; at: string }>;
type SourceRow = (typeof originRead)['~reylo']['element'];
type OriginRow = (typeof lookupOrigin)['~reylo']['element'];
type Request = Readonly<{
  actor: Actor;
  context: AccessContext & { time: AuthoritativeTime; work: AccessWorkAccounting };
}>;
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const missingReceipt =
  'Semantic identity-scope-committed-receipt: committed IdentityNativeReceipt and catalogue-root closure are not installed';
const zero: WorkDimensions = Object.freeze({
  candidateKeys: 0,
  nativeRows: 0,
  nativePoints: 0,
  identityMetadataRows: 0,
  witnessKeys: 0,
  emptySeeks: 0,
  statements: 0,
  bytes: 0,
});
const axes = Object.keys(zero) as (keyof WorkDimensions)[];
function add(...values: readonly WorkDimensions[]): WorkDimensions {
  const result = { ...zero };
  for (const axis of axes) for (const value of values) result[axis] += value[axis];
  return Object.freeze(result);
}
function bridge(value: AccessWork): WorkDimensions {
  return {
    candidateKeys: value.keys,
    nativeRows: value.rows,
    nativePoints: value.points,
    identityMetadataRows: 0,
    witnessKeys: value.witnesses,
    emptySeeks: value.emptySeeks,
    statements: 0,
    bytes: value.bytes,
  };
}
function sameLocator(a: CollectionKindPreparationLocator, b: CollectionKindPreparationLocator) {
  return (
    a.route === b.route &&
    a.ownerAccountId === b.ownerAccountId &&
    a.collectionId === b.collectionId &&
    a.preparationId === b.preparationId
  );
}
function locatorValid(value: CollectionKindPreparationLocator): boolean {
  return (
    !!value &&
    Object.keys(value).sort().join(',') === 'collectionId,ownerAccountId,preparationId,route' &&
    routeOf(value.collectionId) === value.route &&
    routeOf(value.ownerAccountId) === value.route &&
    uuid.test(value.preparationId)
  );
}
function reference(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    Buffer.byteLength(value) >= 1 &&
    Buffer.byteLength(value) <= 255 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}
function parameters(locator: CollectionKindPreparationLocator) {
  return {
    route: locator.route,
    owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId,
    preparation_id: locator.preparationId,
  };
}
// Pure declaration for each closed owner query. Include indexed join/lock keys,
// row-work of every joined relation, bounded projections, input and SQL bytes.
function queryWork(sql: string, values: unknown, rows: number, points: number, projection: number): WorkDimensions {
  return Object.freeze({
    ...zero,
    candidateKeys: points,
    nativeRows: rows,
    nativePoints: points,
    emptySeeks: 1,
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + projection,
  });
}
function sourcePlan(locator: CollectionKindPreparationLocator, original: Original) {
  return queryWork(originRead.sql, { ...parameters(locator), audience: original.audience }, 4, 4, 12 * 4096 + 1024);
}
function originalPlan(locator: CollectionKindPreparationLocator, id: string, original: Original, deadline: number) {
  return queryWork(
    lookupOrigin.sql,
    { ...parameters(locator), origin_id: id, audience: original.audience, at: original.at, now_ms: String(deadline) },
    6,
    6,
    6 * 4096 + 2048,
  );
}
function insertPlan(locator: CollectionKindPreparationLocator, original: Original) {
  // Longest native capture is 4096 UTF8 bytes; JSON escaping expands each byte by <=6.
  return queryWork(insertOrigin.sql, { ...parameters(locator), audience: original.audience }, 3, 3, 6 * 4096 + 2048);
}
const controls = Object.freeze({ ...zero, nativePoints: 1, statements: 6, bytes: 1024 });

export function createKindAudienceOriginal(
  config: Readonly<{
    identity?: KindOriginalProducer;
    formulaDigest: string;
    formulaBound(request: Request): AccessWork | undefined;
    formulaOverhead(request: Request): WorkDimensions;
    prepareFormula(input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
    gates(request: Request, root: ReadDecisions): Promise<boolean>;
  }>,
): KindAudienceAccess {
  const accessReceipts = new WeakMap<WorkReceipt, AccessWork>();
  function original(request: Request): Original | undefined {
    const identity = config.identity?.(request.actor, request.context);
    if (
      !identity ||
      !Number.isFinite(identity.expires) ||
      Date.now() >= Math.min(identity.expires, request.context.deadline)
    )
      return undefined;
    const at = authoritativeTimeValue(request.context.time);
    const actor = request.actor;
    const claims =
      actor.kind === 'anonymous'
        ? ['anonymous']
        : [actor.accountId, actor.clientId, actor.authnEpoch, actor.requestedBy, [...actor.scopes].sort()];
    return Object.freeze({
      audience: actor.kind === 'anonymous' ? 'anonymous' : `reader:${hash(claims).slice(7)}`,
      digest: hash([claims, identity.account, identity.expires]),
      expires: identity.expires,
      deadline: request.context.deadline,
      at,
    });
  }
  function nativeContext(context: AccessContext): context is Request['context'] {
    return !!context.time && !!context.work;
  }
  function fresh(input: KindAudienceFreshRequest | undefined): Request | undefined {
    if (!input || !nativeContext(input.context)) return undefined;
    return {
      actor: input.kind === 'authenticated' ? input.actor : Object.freeze({ kind: 'anonymous' }),
      context: input.context,
    };
  }
  function frame(context: Pick<AccessContext, 'pool' | 'deadline'>, allowance: WorkAllowance) {
    const value = currentCommandWorkAssociation();
    return value && value.deadline === context.deadline && value.receipt().reservationId === allowance.reservationId
      ? value
      : undefined;
  }
  function assertOriginal(input: Request, expected: Original) {
    requireAccessDeadline(input.context.deadline);
    const actual = original(input);
    if (
      !actual ||
      actual.digest !== expected.digest ||
      actual.audience !== expected.audience ||
      actual.at !== expected.at
    )
      throw new AccessWorkUnavailableError('Collection Kind original authentication changed during invocation');
  }
  function operation<I extends object, R extends Readonly<{ work: WorkReceipt }>>(
    bound: (input: I) => KindAudienceWorkDeclaration | undefined,
    run: (input: I, declaration: KindAudienceWorkDeclaration) => Promise<R>,
  ): KindAudienceOperation<I, R> {
    const receipts = new WeakMap<R, { input: I; declaration: KindAudienceWorkDeclaration }>();
    return Object.freeze({
      bound,
      async run(input) {
        const declaration = bound(input);
        if (!declaration) throw new AccessWorkUnavailableError('Collection Kind audience original admitted operation');
        const result = await run(input, declaration);
        receipts.set(result, {
          input,
          declaration: Object.freeze({
            access: accessReceipts.get(result.work) ?? EMPTY_ACCESS_WORK,
            source: result.work.used,
          }),
        });
        return result;
      },
      actual(input, result) {
        const receipt = receipts.get(result);
        if (!receipt || receipt.input !== input) return undefined;
        receipts.delete(result);
        return receipt.declaration;
      },
    });
  }
  function detachedBound(
    locator: CollectionKindPreparationLocator,
    input: Request,
    allowance: WorkAllowance,
    id?: string,
  ) {
    if (!locatorValid(locator) || (id !== undefined && !reference(id))) return undefined;
    const current = frame(input.context, allowance);
    const identity = original(input);
    const access = config.formulaBound(input);
    if (!current || current.access !== input.context.work || !identity || !access) return undefined;
    const native = add(
      controls,
      config.formulaOverhead(input),
      sourcePlan(locator, identity),
      insertPlan(locator, identity),
      queryWork(readCommittedInput.sql, parameters(locator), 3, 3, 6 * 4096 + 512),
      originalPlan(locator, id ?? 'sha256:' + '0'.repeat(64), identity, input.context.deadline),
    );
    return Object.freeze({ access, source: add(native, bridge(access)) });
  }
  async function detached<T>(
    locator: CollectionKindPreparationLocator,
    input: Request,
    allowance: WorkAllowance,
    bound: KindAudienceWorkDeclaration,
    body: (
      client: import('../request/access.ts').AccessClient,
      source: SourceRow,
      identity: Original,
    ) => Promise<T | null>,
  ) {
    const current = frame(input.context, allowance);
    const identity = original(input);
    if (!current || !identity) throw new AccessWorkUnavailableError('Collection Kind original frame');
    // Hold native overhead and the original Access invocation separately in the SAME frame.
    // The Access bridge is included in source above exactly once, never paid a second time.
    const overhead = { ...bound.source };
    const accessSource = bridge(bound.access);
    for (const axis of axes) overhead[axis] -= accessSource[axis];
    const result: { value: T | null } = { value: null };
    let accessUsed = EMPTY_ACCESS_WORK;
    await current.run('kind-audience.original-controls', overhead, async () => {
      const evaluated = await input.context.work.invocation(
        'kind-audience.original-formula',
        bound.access,
        async () => {
          const root = await config.prepareFormula({
            actor: input.actor,
            actions: new Set(['collection:read']),
            time: input.context.time,
            context: input.context,
          });
          assertOriginal(input, identity);
          if (!(await config.gates(input, root))) return;
          assertOriginal(input, identity);
          result.value = await withConnection(input.context.pool, async (client) => {
            const native = deadlineClient(client, input.context.deadline);
            await native.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
            try {
              await native.query("SET LOCAL lock_timeout = '200ms'");
              await native.query(
                `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(input.context.deadline - Date.now()))}ms'`,
              );
              const source = await originRead.run(native, { ...parameters(locator), audience: identity.audience });
              assertOriginal(input, identity);
              if (!source) {
                await native.query('COMMIT');
                return null;
              }
              const floor: ReadDecisionEligibility = async (_client, ids) =>
                Object.freeze(
                  Object.fromEntries(
                    ids.map((id) => [id, id === locator.collectionId && source.visibility !== 'private']),
                  ),
                );
              floor.work = Object.freeze({ bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK });
              const decision = await root.decide(
                native,
                {
                  action: 'collection:read',
                  resourceType: 'library.collection',
                  ids: [locator.collectionId],
                  eligibility: floor,
                },
                input.context.time,
              );
              assertOriginal(input, identity);
              const allowed =
                decision[locator.collectionId]?.allowed === true &&
                !(
                  source.visibility === 'private' &&
                  source.membershipKind === 'dynamic' &&
                  (input.actor.kind !== 'account' || input.actor.accountId !== locator.ownerAccountId)
                );
              const value = allowed ? await body(native, source, identity) : null;
              assertOriginal(input, identity);
              await native.query('COMMIT');
              assertOriginal(input, identity);
              return value;
            } catch (error) {
              await client.query('ROLLBACK').catch((failure: Error) => discardConnection(client, failure));
              throw error;
            }
          });
        },
      );
      accessUsed = evaluated.usage;
    });
    const sourceUsed = { ...bridge(accessUsed), nativeRows: bound.access.rows };
    const work = Object.freeze({ reservationId: allowance.reservationId, used: add(overhead, sourceUsed) });
    accessReceipts.set(work, accessUsed);
    return { value: result.value, work };
  }
  function localRequest(
    input:
      | import('./kind-audience.ts').ResolveKindAudienceInput
      | import('./kind-audience.ts').VerifyKindAudienceSourceInput,
  ) {
    const native = collectionKindPreparationNativeWork(input.work);
    if (
      !native ||
      !hasOperationalAdmission(input.work.tx, native) ||
      native.deadlineAt !== input.deadline ||
      native.receipt().reservationId !== input.allowance.reservationId
    )
      return undefined;
    const resources = currentOperationalResources(input.work.tx);
    const originalRequest = fresh(input.request);
    const identity = originalRequest && original(originalRequest);
    if (!identity || resources.pool !== originalRequest!.context.pool || resources.deadline !== input.deadline)
      return undefined;
    return { native, resources, identity, originalRequest: originalRequest! };
  }
  function localBound(
    input:
      | import('./kind-audience.ts').ResolveKindAudienceInput
      | import('./kind-audience.ts').VerifyKindAudienceSourceInput,
    id: string,
  ) {
    const held = localRequest(input);
    if (!held || !locatorValid(input.work.locator) || !reference(id)) return undefined;
    return { access: EMPTY_ACCESS_WORK, source: originalPlan(input.work.locator, id, held.identity, input.deadline) };
  }
  async function local(
    input:
      | import('./kind-audience.ts').ResolveKindAudienceInput
      | import('./kind-audience.ts').VerifyKindAudienceSourceInput,
    id: string,
    bound: KindAudienceWorkDeclaration,
  ) {
    const held = localRequest(input);
    if (!held) throw new AccessWorkUnavailableError('Collection Kind live Source original');
    const time = commandTime(input.work.tx);
    if (!time) throw new AccessWorkUnavailableError('Collection Kind Source time');
    // Reserve before the exact literal on the already checked-out live home.
    // Native query suppresses only duplicate instrumentation of this one query.
    const reservation = held.native.reserve(bound.source);
    reservation.dispatch();
    let row: OriginRow | null | undefined;
    try {
      row = await reservation.query(() =>
        lookupOrigin.run(input.work.tx, {
          ...parameters(input.work.locator),
          origin_id: id,
          audience: held.identity.audience,
          at: authoritativeTimeValue(time),
          now_ms: String(Date.now()),
        }),
      );
    } finally {
      // Failed/rolled-back reads consume the same bound; no free retry.
      reservation.settle();
    }
    assertOriginal(held.originalRequest, held.identity);
    if (!localRequest(input) || commandTime(input.work.tx) !== time)
      throw new AccessWorkUnavailableError('Collection Kind Source invocation ended');
    return { row, work: Object.freeze({ reservationId: input.allowance.reservationId, used: bound.source }) };
  }
  function matches(row: OriginRow | null | undefined, identity: Original, source?: SourceRow): boolean {
    return (
      !!row &&
      !row.cancelled &&
      row.originalDigest === identity.digest &&
      row.formulaDigest === config.formulaDigest &&
      Date.parse(row.expiresAt) === identity.expires &&
      row.deadlineAt === String(identity.deadline) &&
      Date.now() < identity.deadline &&
      (!source || (row.sourceGeneration === source.sourceGeneration && row.sourceCapture === source.capture))
    );
  }
  return Object.freeze({
    capture: operation<
      import('./kind-audience.ts').CaptureKindAudienceOriginInput,
      import('./kind-audience.ts').CaptureKindAudienceOriginResult
    >(
      (input) => detachedBound(input.locator, input, input.allowance),
      async (input, bound) => {
        const result = await detached(
          input.locator,
          input,
          input.allowance,
          bound,
          async (client, source, identity) => {
            const id = hash([input.locator, identity.digest]);
            await insertOrigin.run(client, {
              ...parameters(input.locator),
              origin_id: id,
              audience: identity.audience,
              original_digest: identity.digest,
              formula_digest: config.formulaDigest,
              source_generation: source.sourceGeneration,
              source_capture: source.capture,
              origin_at: identity.at,
              expires_at: new Date(identity.expires).toISOString(),
              deadline_at: String(input.context.deadline),
            });
            const row = await lookupOrigin.run(client, {
              ...parameters(input.locator),
              origin_id: id,
              audience: identity.audience,
              at: identity.at,
              now_ms: String(Date.now()),
            });
            if (!matches(row, identity, source) || row?.deadlineAt !== String(input.context.deadline)) return null;
            return Object.freeze({
              kind: 'collection-kind-audience-origin' as const,
              locator: Object.freeze({ ...input.locator }),
              id,
            });
          },
        );
        return result.value
          ? { status: 'captured', origin: result.value, work: result.work }
          : { status: 'unavailable', work: result.work };
      },
    ),
    resolveInput: operation<
      import('./kind-audience.ts').ResolveKindAudienceInput,
      import('./kind-audience.ts').ResolveKindAudienceResult
    >(
      (input) => {
        const local = sameLocator(input.origin.locator, input.work.locator)
          ? localBound(input, input.origin.id)
          : undefined;
        return local && { access: local.access, source: add(local.source, collectionKindInputWork()) };
      },
      async (input, _bound) => {
        const held = localRequest(input);
        if (!held) throw new AccessWorkUnavailableError('Collection Kind original input frame');
        const before = held.native.receipt().used;
        const localDeclaration = localBound(input, input.origin.id)!;
        const result = await local(input, input.origin.id, localDeclaration);
        if (!matches(result.row, held.identity) || !result.row?.referenceId)
          return {
            status: 'unavailable',
            reason: 'Collection Kind origin/enrollment is stale or absent',
            work: result.work,
          };
        // Real Source reads, immutable write and exact collision readback share the
        // original live home. The first result waits for THIS transaction's commit;
        // no Type completion or foreign repair receipt is required for the next lookup.
        const resolved = await resolveCollectionKindRawInput(
          input.work.tx,
          input.work.locator,
          input.origin.id,
          held.native,
        );
        assertOriginal(held.originalRequest, held.identity);
        if (!localRequest(input)) throw new AccessWorkUnavailableError('Collection Kind input invocation ended');
        const after = held.native.receipt().used;
        const used = { ...zero };
        for (const axis of axes) used[axis] = after[axis] - before[axis];
        const work = Object.freeze({ reservationId: input.allowance.reservationId, used: Object.freeze(used) });
        return resolved.status === 'committed'
          ? {
              status: 'resolved',
              origin: input.origin,
              input: Object.freeze({
                kind: 'collection-kind-audience-input',
                locator: Object.freeze({ ...input.work.locator }),
                id: resolved.binding.inputId,
              }),
              binding: resolved.binding,
              work,
            }
          : {
              status: 'unavailable',
              reason:
                resolved.status === 'awaiting_commit'
                  ? 'Collection Kind raw interval awaits the original Source transaction commit'
                  : resolved.reason,
              work,
            };
      },
    ),
    prepare: operation<
      import('./kind-audience.ts').PrepareKindAudienceInput,
      import('./kind-audience.ts').PrepareKindAudienceResult
    >(
      (input) => {
        const live = fresh(input.request);
        return live &&
          input.context.pool === live.context.pool &&
          input.context.deadline === live.context.deadline &&
          sameLocator(input.origin.locator, input.input.locator) &&
          reference(input.input.id)
          ? detachedBound(input.origin.locator, live, input.allowance, input.origin.id)
          : undefined;
      },
      async (input, bound) => {
        const live = fresh(input.request);
        if (!live) throw new AccessWorkUnavailableError('Collection Kind fresh original');
        const result = await detached(
          input.origin.locator,
          live,
          input.allowance,
          bound,
          async (client, source, identity) => {
            const row = await lookupOrigin.run(client, {
              ...parameters(input.origin.locator),
              origin_id: input.origin.id,
              audience: identity.audience,
              at: identity.at,
              now_ms: String(Date.now()),
            });
            if (!matches(row, identity, source) || !row?.referenceId) return false;
            const committed = await readCommittedInput.run(client, {
              ...parameters(input.origin.locator),
              origin_id: input.origin.id,
              input_id: input.input.id,
            });
            if (!committed?.committed) return false;
            const body: CollectionKindRawInputBody = JSON.parse(committed.body);
            // The immutable native input is a control operand, never permission,
            // Type authority or a proof that the Semantic owners completed.
            return (
              body.format === 1 &&
              body.original.id === input.origin.id &&
              body.original.digest === identity.digest &&
              body.original.formula === config.formulaDigest &&
              body.original.audience === identity.audience &&
              body.source.capture === row.sourceCapture &&
              body.source.identity.generation === row.sourceGeneration &&
              body.enrollment.reference === row.referenceId &&
              body.enrollment.generation === row.enrollmentGeneration
            );
          },
        );
        return {
          status: 'unavailable',
          reason: result.value
            ? missingReceipt
            : 'Collection Kind original formula/source/enrollment is stale or denied',
          work: result.work,
        };
      },
    ),
    verifySource: operation<
      import('./kind-audience.ts').VerifyKindAudienceSourceInput,
      import('./kind-audience.ts').VerifyKindAudienceSourceResult
    >(
      (input) =>
        sameLocator(input.evidence.locator, input.work.locator) ? localBound(input, input.evidence.id) : undefined,
      async (input, bound) => {
        // There is deliberately no evidence factory before all five owners close.
        // Even an id that happens to name a current original cannot acquire currentness.
        const result = await local(input, input.evidence.id, bound);
        return {
          status: result.row ? 'unavailable' : 'stale',
          reason: result.row ? missingReceipt : 'Collection Kind committed evidence is absent',
          work: result.work,
        };
      },
    ),
  });
}
