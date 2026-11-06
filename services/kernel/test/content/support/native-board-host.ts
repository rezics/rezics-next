import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { routeOf } from '../../../src/route/route.ts';

export type NativeHttpKernel = { handle(request: Request): Promise<Response> };
export type NativeHttpActor = { bearer: string };
export type NativeDiscussionBoard = {
  id: string;
  realmId: string;
  spaceId: string;
  schemeId: string;
  conceptId: string;
  sourceIds: string[];
};

type JsonObject = Record<string, unknown>;

function originOf(origin: string): string {
  return origin.replace(/\/$/, '');
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} is not an object`);
  return value as JsonObject;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is missing`);
  return value;
}

async function command<T>(
  kernel: NativeHttpKernel,
  actor: NativeHttpActor,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
  origin: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; value: T | null; text: string }> {
  const request = new Request(`${originOf(origin)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${actor.bearer}`,
      'content-type': 'application/json',
      'idempotency-key': JSON.stringify(crypto.randomUUID()),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const response = await kernel.handle(request);
  const text = await response.text();
  let value: T | null = null;
  if (response.ok && response.status !== 204 && text.length > 0) value = JSON.parse(text) as T;
  return { status: response.status, value, text };
}

async function expectCreated<T>(
  result: { status: number; value: T | null; text: string },
  status: number,
  detail: string,
): Promise<T> {
  if (result.status !== status || result.value === null)
    throw new Error(`${detail} failed (${result.status}): ${result.text}`);
  return result.value;
}

/** Ordinary grant command with a durable receipt. Identity-only SQL rows are not a substitute.
 * The receipt key is the exact grant intent so a later identical POST replays instead of
 * inserting a second row. Access maps that unique conflict to 403, not 409. */
export async function grantAccountActions(
  kernel: NativeHttpKernel,
  grantor: NativeHttpActor,
  resource: { route: number; id: string },
  accountId: string,
  actions: readonly string[],
  origin = 'https://content.test',
): Promise<void> {
  for (const action of actions) {
    const result = await command(
      kernel,
      grantor,
      'POST',
      '/v1/grants',
      {
        resource,
        subject: { kind: 'account', id: accountId },
        actions: [action],
        valid: '(,)',
      },
      origin,
      {
        'idempotency-key': JSON.stringify(
          `accounts.grant:${resource.route}:${resource.id}:${accountId}:${action}`,
        ),
      },
    );
    if (result.status !== 201 && result.status !== 409)
      throw new Error(`Grant ${action} on ${resource.id} failed (${result.status}): ${result.text}`);
  }
}

/** Space, Realm and subject creation on the Global Context. Fixture creators that provision native
 * sources receive these as ordinary receipts, the same way the media fixtures grant them. */
export const NATIVE_CREATION_ACTIONS = ['space:create', 'realm:create', 'subject:create'] as const;

export async function grantNativeCreationAuthority(
  kernel: NativeHttpKernel,
  grantor: NativeHttpActor,
  accountId: string,
  origin = 'https://content.test',
): Promise<void> {
  await grantAccountActions(kernel, grantor, resourceOf(GLOBAL_CONTEXT), accountId, NATIVE_CREATION_ACTIONS, origin);
}

function resourceOf(id: string): { route: number; id: string } {
  const route = routeOf(id);
  if (route === null) throw new TypeError(`Ungrantable resource id ${id}`);
  return { route, id };
}

/** Space, Realm, scheme, concept and published Board through ordinary HTTP routes. */
export async function provisionNativeDiscussionBoard(
  kernel: NativeHttpKernel,
  creator: NativeHttpActor,
  options: {
    label: string;
    origin?: string;
    realmVisibility?: 'public' | 'protected';
    /** Creator account that receives an ordinary space:manage receipt on the new Space. */
    creatorAccountId?: string;
    /** Grantor with `access:grant`; defaults to the Space creator. */
    grantor?: NativeHttpActor;
  },
): Promise<NativeDiscussionBoard> {
  const origin = options.origin ?? 'https://content.test';
  const label = options.label;
  const spaceBody = await expectCreated(
    await command<{ space: { spaceId: string } }>(
      kernel,
      creator,
      'POST',
      '/v1/spaces',
      { title: `${label} space`, summary: `${label} fixture` },
      origin,
    ),
    201,
    `${label} space creation`,
  );
  const spaceId = stringField(jsonObject(spaceBody.space, `${label} space`).spaceId, `${label} space id`);
  if (options.creatorAccountId)
    await grantAccountActions(
      kernel,
      options.grantor ?? creator,
      resourceOf(spaceId),
      options.creatorAccountId,
      ['space:manage'],
      origin,
    );

  const realmBody = await expectCreated(
    await command<{ realm: { realmId: string; headRevisionId: string } }>(
      kernel,
      creator,
      'POST',
      '/v1/realms',
      {
        spaceId,
        title: `${label} Realm`,
        summary: `${label} fixture`,
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      },
      origin,
    ),
    201,
    `${label} Realm creation`,
  );
  const realm = jsonObject(realmBody.realm, `${label} Realm`);
  const realmId = stringField(realm.realmId, `${label} Realm id`);
  let realmHeadRevisionId = stringField(realm.headRevisionId, `${label} Realm head`);
  if (options.realmVisibility === 'protected') {
    const protectedBody = await expectCreated(
      await command<{ realm: { headRevisionId: string } }>(
        kernel,
        creator,
        'PATCH',
        `/v1/realms/${realmId}`,
        { visibility: 'protected' },
        origin,
        { 'if-match': JSON.stringify(realmHeadRevisionId) },
      ),
      200,
      `${label} Realm protection`,
    );
    realmHeadRevisionId = stringField(
      jsonObject(protectedBody.realm, `${label} protected Realm`).headRevisionId,
      `${label} protected Realm head`,
    );
  }

  const schemeBody = await expectCreated(
    await command<{ subject: { id: string } }>(
      kernel,
      creator,
      'POST',
      '/v1/subjects',
      { type: 'skos:ConceptScheme', labels: { en: `${label} scheme` } },
      origin,
    ),
    201,
    `${label} scheme creation`,
  );
  const schemeId = stringField(jsonObject(schemeBody.subject, `${label} scheme`).id, `${label} scheme id`);

  const conceptBody = await expectCreated(
    await command<{ subject: { id: string } }>(
      kernel,
      creator,
      'POST',
      '/v1/subjects',
      {
        type: 'skos:Concept',
        labels: { en: `${label} concept` },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
        },
      },
      origin,
    ),
    201,
    `${label} concept creation`,
  );
  const conceptId = stringField(jsonObject(conceptBody.subject, `${label} concept`).id, `${label} concept id`);

  await expectCreated(
    await command(kernel, creator, 'PUT', `/v1/realms/${realmId}/boardScheme`, { schemeId }, origin, {
      'if-match': JSON.stringify(realmHeadRevisionId),
    }),
    200,
    `${label} board scheme update`,
  );

  const boardBody = await expectCreated(
    await command<{ board: { id: string } }>(
      kernel,
      creator,
      'POST',
      `/v1/realms/${realmId}/boards`,
      { conceptId, title: `${label} board`, visibility: 'published' },
      origin,
    ),
    201,
    `${label} board creation`,
  );
  const boardId = stringField(jsonObject(boardBody.board, `${label} board`).id, `${label} board id`);
  return {
    id: boardId,
    realmId,
    spaceId,
    schemeId,
    conceptId,
    sourceIds: [spaceId, realmId, schemeId, conceptId, boardId],
  };
}

export function grantResource(id: string): { route: number; id: string } {
  return resourceOf(id);
}

/** Public Realm posting still needs current member evidence even when standing admits participate. */
export async function installRealmMember(
  pool: Pool,
  realmId: string,
  accountId: string,
  instant = new Date().toISOString(),
): Promise<void> {
  const realmRoute = routeOf(realmId);
  const accountRoute = routeOf(accountId);
  if (realmRoute === null || accountRoute === null) throw new TypeError('Realm membership ids must be routed');
  const reservationId = randomUUID();
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO community.realm_member
       (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
     SELECT $1,$2,$3,'member',tstzrange($4::timestamptz,NULL,'[)'),$5,$6
     WHERE NOT EXISTS (
       SELECT 1 FROM community.realm_member
       WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND valid @> $4::timestamptz
     )`,
    [realmRoute, realmId, accountId, instant, reservationId, transactionId],
  );
  await pool.query(
    `INSERT INTO access.membership_inverse
       (route,account_id,kind,group_id,reservation_id,transaction_id,source_transaction_id)
     VALUES ($1,$2,'realm',$3,$4,$5,$5)
     ON CONFLICT (route,account_id,kind,group_id) DO NOTHING`,
    [accountRoute, accountId, realmId, reservationId, transactionId],
  );
}
