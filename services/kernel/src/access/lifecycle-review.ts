import { memoizedValue } from '../memoized.ts';
import type { Pool } from 'pg';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck, type Access, type Actor, type AccessClient } from './check.ts';
import { routeOf } from '../route/route.ts';
import { deadlineClient, within } from './deadline.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { suspensionDeclaration, suspensionRequestDigest } from './suspension.ts';
import { reinstatementDeclaration, reinstatementRequestDigest } from './reinstatement.ts';
import { activeHome, effects, hash, originalResult, sameHome, unknownOriginal } from './lifecycle-review-source.ts';
import type { LifecycleReview, LifecycleReviewInput, LifecycleOriginalResult } from './lifecycle-review-contract.ts';
import { classifyUnavailability } from './unavailable.ts';

function declarations() {
  return memoizedValue(declarations, () => [suspensionDeclaration, reinstatementDeclaration] as const);
}
type Target = LifecycleReview['account'] &
  LifecycleReview['current'] & { transactionId: string; fenceReceiptId: string | null };
async function target(client: AccessClient, route: number, accountId: string) {
  const { rows } = await client.query<Target>(
    `SELECT account_id AS id, kind, display_name AS "displayName", handle, state,
      minimum_authn_epoch::text AS "minimumAuthnEpoch", authn_fenced AS fenced,
      fence_receipt_id AS "fenceReceiptId", transaction_id AS "transactionId"
     FROM access.account WHERE route=$1 AND account_id=$2
       AND coalesce(octet_length(display_name),0)<=1024 AND coalesce(octet_length(handle),0)<=64`,
    [route, accountId],
  );
  return rows[0];
}
const deny = () => new ProblemError('not_found');

/** Purpose-specific private review. No management relationship or public identity is an authority input. */
export async function readLifecycleReview(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  input: { accountId: string } & LifecycleReviewInput,
  context: { deadline: number },
): Promise<LifecycleReview> {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  // Capture private command operands before any asynchronous authority or source read.
  input = structuredClone(input);
  const identity = actor;
  const route = routeOf(input.accountId);
  const original = input.original;
  if (
    input.operatorPageKey !== undefined &&
    (!original || typeof input.operatorPageKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.operatorPageKey))
  )
    throw new ProblemError('invalid_request');
  if (
    route === null ||
    Object.keys(input).some((key) => !['accountId', 'original', 'operatorPageKey'].includes(key)) ||
    (original &&
      (Object.keys(original).some((key) => !['operationId', 'key', 'reason'].includes(key)) ||
        !declarations().some((d) => d.operationId === original.operationId) ||
        typeof original.key !== 'string' ||
        original.key.length < 1 ||
        original.key.length > 255 ||
        (original.reason !== undefined &&
          (typeof original.reason !== 'string' || original.reason.length < 1 || original.reason.length > 2000))))
  )
    throw new ProblemError('invalid_request');
  const { pool, access } = deps;
  const { deadline } = context;
  try {
    return await within(deadline, async () => {
      async function authority() {
        // Each disclosure phase mints live native T under the ORIGINAL request deadline.
        const time = await withConnection(pool, (c) => mintReadTime(deadlineClient(c, deadline), deps.clock));
        try {
          const allowed: boolean[] = [];
          for (const declaration of declarations()) {
            // Installed Access validates actor identity, client scopes/consent, delegation, roles and gates.
            // Preparation can contact foreign homes; no checkout is held here.
            const check = await accessCheck(access, identity, declaration.action, PLATFORM_RESOURCE, {
              pool,
              deadline,
              time,
            });
            const eligible = await withConnection(pool, async (connection) => {
              const client = deadlineClient(connection, deadline);
              await activeHome(client, routeOf(identity.accountId)!);
              const current = await target(client, routeOf(identity.accountId)!, identity.accountId);
              return (
                current?.kind === 'actor' &&
                current.state === 'active' &&
                !current.fenced &&
                Number.isSafeInteger(identity.authnEpoch) &&
                identity.authnEpoch >= 1 &&
                BigInt(identity.authnEpoch) >= BigInt(current.minimumAuthnEpoch)
              );
            });
            if (!eligible) throw deny();
            allowed.push(
              await withConnection(pool, async (connection) => {
                const client = deadlineClient(connection, deadline);
                await activeHome(client, PLATFORM_RESOURCE.route);
                const global = await globalRead.run(client, {
                  route: PLATFORM_RESOURCE.route,
                  resource_id: PLATFORM_RESOURCE.id,
                });
                return global?.global === true && (await check(client, time));
              }),
            );
          }
          if (!allowed.some(Boolean) || (original && !allowed[original.operationId === 'account.suspend' ? 0 : 1]))
            throw deny();
          return allowed;
        } finally {
          releaseOperationalTime(time);
        }
      }
      await authority();
      const snapshot = await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        const home = await activeHome(client, route);
        return { home, account: await target(client, route, input.accountId) };
      });
      if (!snapshot.account) throw deny();
      let result: LifecycleOriginalResult | undefined;
      if (original) {
        await authority(); // Exact current command authority BEFORE receipt lookup, regardless of target applicability.
        const operands = {
          accountId: input.accountId,
          key: original.key,
          ...(original.reason === undefined ? {} : { reason: original.reason }),
        };
        const digest =
          original.operationId === 'account.suspend'
            ? suspensionRequestDigest(identity, operands)
            : reinstatementRequestDigest(identity, operands);
        const source = await withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          const home = await activeHome(client, route);
          if (!sameHome(snapshot.home, home)) throw new ProblemError('partition_unavailable');
          return originalResult(client, {
            route,
            accountId: input.accountId,
            principal: identity.accountId,
            operationId: original.operationId,
            key: original.key,
            digest,
          });
        });
        result = source
          ? {
              status: 'recorded',
              receiptId: source.receiptId,
              effects: await effects(
                pool,
                deadline,
                original.operationId === 'account.suspend',
                source,
                input.operatorPageKey,
              ),
            }
          : unknownOriginal();
      }
      // Reprepare after native/foreign reads, including receipt and effect evidence, before disclosing anything.
      const allowed = await authority();
      await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        const home = await activeHome(client, route);
        const current = await target(client, route, input.accountId);
        if (!sameHome(snapshot.home, home) || !current || !hash(current).equals(hash(snapshot.account)))
          throw new ProblemError('dependency_unavailable');
      });
      const a = snapshot.account;
      return {
        account: {
          id: a.id,
          kind: a.kind,
          displayName: a.state === 'deleted' ? null : a.displayName,
          handle: a.state === 'deleted' ? null : a.handle,
        },
        current: { state: a.state, minimumAuthnEpoch: a.minimumAuthnEpoch, fenced: a.fenced },
        actions: declarations()
          .filter(
            (d, i) =>
              allowed[i] &&
              (d.operationId === 'account.suspend'
                ? a.state === 'active'
                : a.state === 'suspended' && a.fenced && a.fenceReceiptId !== null),
          )
          .map((d) => ({ ...d })),
        ...(result ? { original: result } : {}),
      };
    });
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const reason = classifyUnavailability(error);
    if (reason === 'deadline') throw new ProblemError('deadline_exceeded');
    if (reason === 'moved' || reason === 'fenced') throw new ProblemError('partition_unavailable');
    throw new ProblemError('dependency_unavailable');
  }
}
