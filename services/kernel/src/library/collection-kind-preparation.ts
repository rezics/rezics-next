/** Native Collection-kind binding. Locators resolve retained owner records on every call. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AccessUnavailableError } from '../request/unavailable.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { commandTime, mintReadTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  runOperationalTransaction,
} from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { nativeSourceFence } from './canonical-source-store.ts';
import {
  authorizeNativeCollectionMetadata,
  readNativeCollectionMetadata,
  type NativeCollectionMetadata,
} from './collection-source-native.ts';
import { CollectionSourceLedger, NativeCollectionWork } from './collection-source-work.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';
import {
  COLLECTION_KIND_PREPARATION_OBSERVATION,
  COLLECTION_KIND_PREPARATION_TERMS,
  collectionKindInputWorkDimensions,
} from './collection-kind-input-bounds.ts';
import type {
  CollectionKindCapture,
  CollectionKindPreparation,
  CollectionKindSourceBindings,
} from './collection-kind.ts';
import type { NativeSourceFrontier, NativeSourceIdentity } from './native-source-custody.ts';
import scopeQuery from './collection-kind-preparation-scope.sql';
import readObservation from './collection-kind-read.sql';
import retiredCapture from './collection-kind-preparation-retired.sql';
import { collectionKindConsentAdoptionCurrent } from './collection-kind-consent.ts';

const anonymous: Actor = Object.freeze({ kind: 'anonymous' });
const publicAudience = 'anonymous';
const unavailable = () => ({ status: 'unavailable', reason: 'source_unready' }) as const;
const preparation = COLLECTION_KIND_PREPARATION_TERMS;
const scopeBound = collectionKindInputWorkDimensions(preparation.scope);
const observationBound = collectionKindInputWorkDimensions(preparation.observation);
const retiredBound = collectionKindInputWorkDimensions(preparation.retired);
const clockBound = collectionKindInputWorkDimensions(preparation.clock);
/** Access-heavy metadata reads keep their producer charging; adopt/retire use the shared observation plan. */
function allowance(): WorkAllowance {
  return {
    reservationId: crypto.randomUUID(),
    remaining: {
      candidateKeys: 100,
      nativeRows: 1_000_000,
      nativePoints: 10_000,
      identityMetadataRows: 0,
      emptySeeks: 1_000,
      statements: 10_000,
      bytes: 16 * 1024 * 1024,
      witnessKeys: 0,
    },
  };
}
function observationAllowance(deadline: number): CollectionSourceLedger {
  return new CollectionSourceLedger(
    {
      reservationId: crypto.randomUUID(),
      remaining: collectionKindInputWorkDimensions(COLLECTION_KIND_PREPARATION_OBSERVATION),
    },
    deadline,
  );
}
/** Current Summary does not retain complete original-plus-terminal Type/privacy/negative/writer-before-visibility. */
export async function readCollectionKindPreparationType(request: {
  allowance: WorkAllowance;
  deadline: number;
}): Promise<{ status: 'unavailable'; work: WorkReceipt }> {
  const work = new NativeCollectionWork(request.allowance, request.deadline);
  return { status: 'unavailable', work: work.receipt() };
}
function audience(actor: Actor): string {
  if (actor.kind === 'anonymous') return publicAudience;
  // A private lookup namespace, never an authorization verdict or a replayable Actor.
  return `reader:${createHash('sha256')
    .update(
      JSON.stringify([actor.accountId, actor.clientId, actor.authnEpoch, actor.requestedBy, [...actor.scopes].sort()]),
    )
    .digest('hex')}`;
}
function locator(
  capture: CollectionKindCapture,
): { fence: string; captureId: string; holdId: string; scopeCaptureId: string; revision: string } | null {
  if (Buffer.byteLength(capture.token) > 512) return null;
  try {
    const value: unknown = JSON.parse(capture.token);
    if (
      !Array.isArray(value) ||
      value.length !== 6 ||
      value[0] !== 1 ||
      typeof value[1] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value[1]) ||
      typeof value[2] !== 'string' ||
      routeOf(value[2]) === null ||
      typeof value[3] !== 'string' ||
      routeOf(value[3]) === null ||
      typeof value[4] !== 'string' ||
      routeOf(value[4]) === null ||
      typeof value[5] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value[5])
    )
      return null;
    return { fence: value[1], captureId: value[2], holdId: value[3], scopeCaptureId: value[4], revision: value[5] };
  } catch {
    return null;
  }
}
function identityObservation(
  identity: NativeSourceIdentity,
  captureId: string,
  revision: string,
): IdentityScopeObservation {
  return {
    key: { source: { kind: 'library', identity }, scopeId: 'collection-source' },
    captureId,
    committedRevision: BigInt(revision),
  };
}
/** Expected producer refusal is pending; infrastructure/SQL/programming errors remain failures. */
async function guarded<T>(body: () => Promise<T>) {
  try {
    return await body();
  } catch (error) {
    if (
      error instanceof AccessUnavailableError ||
      (error instanceof ProblemError &&
        ['dependency_unavailable', 'semantic_not_ready', 'not_found', 'stale_cursor', 'invalid_cursor'].includes(
          error.code,
        ))
    )
      return unavailable();
    throw error;
  }
}

export function createCollectionKindPreparation(sources: CollectionKindSourceBindings): CollectionKindPreparation {
  const deps = sources.dependencies;

  async function current(collectionId: string, actor: Actor, deadline: number) {
    if (
      !deps.access ||
      !deps.routeKey ||
      deps.routeKey.byteLength !== 32 ||
      !Number.isFinite(deadline) ||
      Date.now() >= deadline
    )
      return null;
    const route = routeOf(collectionId);
    if (route === null) return null;
    const work = new CollectionSourceLedger(allowance(), deadline);
    const read = await work.run((allowance) =>
      readNativeCollectionMetadata(deps.pool, { route, collectionId }, { allowance, deadline }),
    );
    const metadata = read.metadata;
    if (!metadata || metadata.state !== 'active') return null;
    const at = await work.bounded(clockBound, () =>
      withConnection(deps.pool, (client) => mintReadTime(deadlineClient(client, deadline), deps.clock)),
    );
    const authorized = await work.run((allowance) =>
      authorizeNativeCollectionMetadata(deps.pool, metadata, { access: deps.access!, actor, at, allowance, deadline }),
    );
    return authorized.authorized ? { metadata, at, work } : null;
  }

  /** Exact current native Source, including population/excluded/order dependencies; no capture is minted here. */
  async function retained(metadata: NativeCollectionMetadata, work: CollectionSourceLedger, deadline: number) {
    const rows = await work.bounded(scopeBound, () =>
      withConnection(deps.pool, (client) =>
        scopeQuery.run(deadlineClient(client, deadline), {
          route: metadata.route,
          collection_id: metadata.collectionId,
          source_fence: nativeSourceFence(metadata),
        }),
      ),
    );
    if (!rows) return null;
    const identity = rows.identity as NativeSourceIdentity;
    const frontier = rows.frontier as NativeSourceFrontier | null;
    if (
      !frontier ||
      frontier.driver !== 'done' ||
      !rows.complete ||
      !rows.capture ||
      rows.revision === null ||
      identity.route !== metadata.route ||
      identity.collectionId !== metadata.collectionId ||
      identity.scope === 'public_output' ||
      identity.accountId !== metadata.curatorAccountId ||
      identity.incarnation !== metadata.incarnation ||
      identity.generation !== metadata.sourceGeneration ||
      identity.ownerEpoch !== metadata.stamp.epoch ||
      identity.scope !== metadata.authority ||
      rows.nativeCaptureId !== frontier.captureId ||
      !rows.transactionId ||
      !rows.committed
    )
      return null;
    const observation = identityObservation(identity, rows.capture, rows.revision);
    const checked = await sources.identity.revalidate({ key: observation.key, expected: observation, deadline });
    work.take({
      reservationId: work.allowance().reservationId,
      used: {
        candidateKeys: 0,
        nativeRows: checked.work.rows,
        nativePoints: checked.work.points,
        identityMetadataRows: 0,
        witnessKeys: 0,
        emptySeeks: 0,
        statements: checked.work.statements,
        bytes: checked.work.bytes,
      },
    });
    if (checked.status !== 'current' || !isDeepStrictEqual(checked.observation, observation)) return null;
    return { identity, frontier, observation, scanned: rows.scanned };
  }

  async function resolve(capture: CollectionKindCapture, actor: Actor, deadline: number) {
    const key = locator(capture);
    if (!key || capture.audience !== audience(actor)) return null;
    const read = await current(capture.collectionId, actor, deadline);
    if (
      !read ||
      read.metadata.curatorAccountId !== capture.accountId ||
      read.metadata.sourceGeneration !== capture.sourceGeneration ||
      nativeSourceFence(read.metadata) !== key.fence
    )
      return null;
    const native = await retained(read.metadata, read.work, deadline);
    if (
      !native ||
      native.frontier.captureId !== key.captureId ||
      native.observation.captureId !== key.scopeCaptureId ||
      native.observation.committedRevision.toString() !== key.revision
    )
      return null;
    // The existing scope producer covers original identity and source population, not retained Type/Access
    // changes. Only the truly zero native population has vacuous Type/disclosure dependencies. Nonempty
    // preparations stay unavailable until the native owner supplies that scoped proof; no sample substitutes.
    if (native.scanned !== '0') return null;
    // Recheck current viewer/source authority after the Semantic wait; never retain its allow verdict.
    const final = await current(capture.collectionId, actor, deadline);
    if (!final || nativeSourceFence(final.metadata) !== key.fence) return null;
    return { ...read, ...native, key, at: final.at };
  }

  return {
    prepare(input) {
      return guarded(async () => {
        // Work locators have no verified principal. Only genuine anonymous Source reads are applicable here.
        // Authenticated mutation-origin continuation needs the registered Accounts/Search capability, which
        // MembersPreparation does not currently provide. Never turn accountId or audience into an Actor.
        if (input.audience !== null && input.audience !== publicAudience) return unavailable();
        const read = await current(input.collectionId, anonymous, input.deadline);
        if (!read || read.metadata.curatorAccountId !== input.accountId || read.metadata.authority !== 'curated')
          return unavailable();
        const native = await retained(read.metadata, read.work, input.deadline);
        if (!native || native.scanned !== '0') return unavailable();
        // Reuse the actual native capture; finish resolves its committed receipt and current source fences.
        const completed = await read.work.run((allowance) =>
          sources.custody.finishCapture({
            identity: native.identity,
            frontier: native.frontier,
            allowance,
            deadline: input.deadline,
          }),
        );
        if (completed.status !== 'complete') return unavailable();
        const previous = await read.work.bounded(observationBound, () =>
          withConnection(deps.pool, (client) =>
            readObservation.run(deadlineClient(client, input.deadline), {
              route: read.metadata.route,
              collection_id: input.collectionId,
              audience: publicAudience,
            }),
          ),
        );
        const priorKey = previous
          ? locator({
              collectionId: input.collectionId,
              accountId: input.accountId,
              audience: publicAudience,
              sourceGeneration: previous.sourceGeneration,
              token: previous.capture,
            })
          : null;
        const capture: CollectionKindCapture = {
          collectionId: input.collectionId,
          accountId: input.accountId,
          audience: publicAudience,
          sourceGeneration: read.metadata.sourceGeneration,
          // Reuse the adopted observation's exact hold on continuation. A later observation receives a new hold.
          token: JSON.stringify([
            1,
            nativeSourceFence(read.metadata),
            completed.capture.captureId,
            priorKey?.captureId === completed.capture.captureId &&
            priorKey.revision === native.observation.committedRevision.toString()
              ? priorKey.holdId
              : crypto.randomUUID(),
            native.observation.captureId,
            native.observation.committedRevision.toString(),
          ]),
        };
        if (!(await resolve(capture, anonymous, input.deadline))) return unavailable();
        return { status: 'prepared' as const, capture };
      });
    },
    select(input) {
      return guarded(async () => {
        const read = await current(input.collectionId, input.actor, input.deadline);
        return read ? { status: 'selected' as const, audience: audience(input.actor) } : unavailable();
      });
    },
    resume(input) {
      return guarded<Awaited<ReturnType<CollectionKindPreparation['resume']>>>(async () => {
        if (input.capture.audience !== publicAudience || !deps.access || !deps.routeKey) return unavailable();
        const read = await resolve(input.capture, anonymous, input.deadline);
        if (!read) return unavailable();
        const prepared = await read.work.run((allowance) =>
          sources.source(deps.access!).prepare({
            collectionId: input.capture.collectionId,
            actor: anonymous,
            at: read.at,
            deadline: input.deadline,
            allowance,
          }),
        );
        // Handles belong to the Source instance which created them. Retain that same native reader for page.
        // source() is composed once per resume by the binding below, never recovered from serialized data.
        const access = deps.access;
        return {
          status: 'prepared' as const,
          access,
          identity: read.observation,
          step: {
            actor: anonymous,
            at: read.at,
            deadline: input.deadline,
            source: prepared.source,
            allowance: read.work.allowance(),
            readType: async (request) => readCollectionKindPreparationType(request),
          },
        };
      });
    },
    revalidate(input) {
      return guarded(async () => {
        const actor = input.actor ?? (input.capture.audience === publicAudience ? anonymous : null);
        if (!actor) return unavailable();
        return (await resolve(input.capture, actor, input.deadline))
          ? { status: 'current' as const }
          : { status: 'stale' as const };
      });
    },
    adopt(input) {
      return guarded(async () => {
        const key = locator(input.capture);
        if (!key || !hasLiveOperationalTransaction(input.tx)) return unavailable();
        const resources = currentOperationalResources(input.tx);
        if (
          resources.pool !== deps.pool ||
          resources.mode !== 'work-step' ||
          resources.partition !== partitionOf(routeOf(input.capture.collectionId)!) ||
          resources.accounts.length !== 1 ||
          resources.accounts[0] !== input.capture.accountId
        )
          return unavailable();
        if (input.capture.audience !== publicAudience) {
          const consent = input.capture.consent;
          if (!consent || !(await collectionKindConsentAdoptionCurrent(deps.pool, input.tx, consent)))
            return { status: 'stale' as const };
        }
        // SAME home only. No Source/Access/identity callback or foreign checkout while Core is held.
        const work = observationAllowance(Math.min(input.deadline, resources.deadline));
        const row = await work.bounded(scopeBound, () =>
          scopeQuery.run(input.tx, {
            route: routeOf(input.capture.collectionId)!,
            collection_id: input.capture.collectionId,
            source_fence: key.fence,
          }),
        );
        if (
          !row ||
          row.nativeCaptureId !== key.captureId ||
          row.scanned !== '0' ||
          !row.complete ||
          !row.committed ||
          row.capture !== key.scopeCaptureId ||
          row.revision !== key.revision
        )
          return { status: 'stale' as const };
        const identity = row.identity as NativeSourceIdentity;
        if (
          identity.scope === 'public_output' ||
          identity.accountId !== input.capture.accountId ||
          identity.generation !== input.capture.sourceGeneration
        )
          return { status: 'stale' as const };
        const at = commandTime(input.tx);
        if (!at) return unavailable();
        const held = await work.run((allowance) =>
          sources.custody.readAndHold({
            client: input.tx,
            at,
            identity,
            captureId: key.captureId,
            holdId: key.holdId,
            allowance,
            deadline: Math.min(input.deadline, resources.deadline),
          }),
        );
        return held.status === 'held' ? { status: 'adopted' as const } : unavailable();
      });
    },
    retire(input) {
      return guarded(async () => {
        // Only exact already-adopted custody may be released; no Source purge or public destination ACK.
        const key = locator({ ...input, audience: publicAudience, sourceGeneration: '' });
        const route = routeOf(input.collectionId);
        if (!key || route === null || !deps.workClient) return unavailable();
        return runOperationalTransaction(
          deps.pool,
          {
            mode: 'work-step',
            partition: partitionOf(route),
            kind: 'library.collectionKind.retire',
            accounts: [input.accountId],
            workClient: deps.workClient,
            deadline: input.deadline,
            ...(deps.clock ? { clock: deps.clock } : {}),
          },
          async (tx) => {
            const work = new CollectionSourceLedger(allowance(), input.deadline);
            const retired = await work.bounded(retiredBound, () =>
              retiredCapture.run(tx, {
                route,
                collection_id: input.collectionId,
                account_id: input.accountId,
                capture: input.token,
              }),
            );
            if (!retired) return unavailable();
            const row = await work.bounded(scopeBound, () =>
              scopeQuery.run(tx, { route, collection_id: input.collectionId, source_fence: key.fence }),
            );
            if (!row || row.nativeCaptureId !== key.captureId) return unavailable();
            const identity = row.identity as NativeSourceIdentity;
            if (
              identity.scope === 'public_output' ||
              identity.accountId !== input.accountId ||
              identity.collectionId !== input.collectionId
            )
              return unavailable();
            const at = commandTime(tx);
            if (!at) return unavailable();
            const released = await work.run((allowance) =>
              sources.custody.releaseHold({
                client: tx,
                at,
                identity,
                captureId: key.captureId,
                holdId: key.holdId,
                allowance,
                deadline: input.deadline,
              }),
            );
            return released.status === 'released' ? { status: 'retired' as const } : unavailable();
          },
        );
      });
    },
  };
}
