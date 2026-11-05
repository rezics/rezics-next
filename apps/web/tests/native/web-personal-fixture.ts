import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { documentText, fromPlainText, parseStoredDocument } from '@rezics/document';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { PersonalFacts, PersonalFixture } from '../../../../specs/web-personal-driver.ts';
import type fixtureData from '../../../../specs/fixtures/web-personal.json';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { createNativeDiscussionFixture } from './native-discussion-fixture.ts';
import type { NativeWebStack } from './stack.ts';

export type PersonalData = typeof fixtureData;
export type StripeFixture = ReturnType<typeof startFakeStripe>;
export const personalRequest = (body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function nativePersonalJson<T>(response: Response, status: number, operation: string): Promise<T> {
  if (response.status !== status) throw new Error(`${operation}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export function releasedPersonalChoices(): PersonalFixture['choices'] {
  const profile = (type: string) => {
    const id = bundledRelease.types[type]?.library?.profileId;
    const value = id ? bundledRelease.libraryProfiles?.[id] : undefined;
    if (!value) throw new Error(`Bundled release has no ${type} Library profile`);
    return value;
  };
  const book = profile('schema:Book');
  const recipe = profile('schema:Recipe');
  const states = book.entryStateSet?.states;
  const recipeState = recipe.entryStateSet?.states[0]?.id;
  const kind = book.copies?.kinds[0];
  const unit = book.progress?.allowed.find((mode) => mode.mode === 'scalar_amount')?.units[0];
  if (!states?.[0] || !states[1] || !recipeState || !kind?.statuses[0] || !unit)
    throw new Error('Bundled Book/Recipe profiles lack the personal journey choices');
  return {
    bookState: states[0].id,
    otherBookState: states[1].id,
    recipeState,
    copyKind: kind.id,
    copyStatus: kind.statuses[0].id,
    progressUnit: unit.id,
  };
}

export async function personalGrant(
  stack: NativeWebStack,
  resource: { route: number; id: string },
  accountId: string,
  actions: string[],
  persona = 'governor',
): Promise<Response> {
  return stack.kernel(
    '/v1/grants',
    personalRequest({ resource, subject: { kind: 'account', id: accountId }, actions, valid: '(,)' }),
    persona,
  );
}

/** Provision only catalogue/setup facts. Personal facts are left to the served UI. */
export async function provisionPersonalFixture(stack: NativeWebStack, input: unknown): Promise<PersonalFixture> {
  const data = input as PersonalData;
  if (data?.version !== 1 || !Array.isArray(data.subjects) || !Array.isArray(data.members?.keys))
    throw new Error('Expected the original version 1 web personal fixture');
  const active = await nativePersonalJson<{ digest: string }>(
    await stack.kernel('/v1/definitions/active'),
    200,
    'GET /v1/definitions/active',
  );
  if (active.digest !== bundledDigest)
    throw new Error(`Expected bundled release ${bundledDigest}, got ${active.digest}`);
  const choices = releasedPersonalChoices();
  const [alice, bob, seller, steward] = await Promise.all(
    ['alice', 'bob', 'seller', 'steward'].map((persona) => stack.authPersona(persona)),
  );
  if (!alice || !bob || !seller || !steward) throw new Error('Native setup identities are missing');
  // No exposure opens: a closed production group must keep its real refusal.
  for (const [id, resource, actions] of [
    [steward.accountId, { route: 0, id: GLOBAL_CONTEXT }, ['subject:create', 'zone:create']],
    [seller.accountId, PLATFORM_RESOURCE, ['offer:create']],
  ] as const)
    await nativePersonalJson(await personalGrant(stack, resource, id, [...actions]), 201, 'POST /v1/grants');

  const subjects: PersonalFixture['subjects'] = {};
  const create = async (key: string, type: string, title: string, statements: Record<string, unknown> = {}) => {
    if (!bundledRelease.types[type]) throw new Error(`Bundled release lacks ${type}`);
    const result = await nativePersonalJson<{ subject: { id: string; type: string } }>(
      await stack.kernel('/v1/subjects', personalRequest({ type, labels: { en: title }, statements }), 'steward'),
      201,
      `POST /v1/subjects (${key})`,
    );
    // Observe the actual native type independently; a page's Schema.org mapping cannot stand in for it.
    const read = await nativePersonalJson<{ subject: { id: string; type: string } }>(
      await stack.kernel(`/v1/subjects/${result.subject.id}`),
      200,
      `GET /v1/subjects/${result.subject.id}`,
    );
    if (read.subject.type !== type) throw new Error(`Native ${key} type ${read.subject.type} differs from ${type}`);
    subjects[key] = { id: read.subject.id, title };
    return read.subject.id;
  };
  const statement = (property: string, content: unknown) => ({
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.org/web-personal/controlled-fixture' },
          },
        ],
      },
    ],
  });
  const scheme = await create('fixture-tags', 'skos:ConceptScheme', 'Fixture tags');
  for (const concept of data.concepts)
    await create(concept.key, concept.type, concept.label, {
      'skos:inScheme': [statement('skos:inScheme', scheme)],
      'schema:description': [statement('schema:description', { language: 'en', text: concept.attribution })],
    });
  for (const subject of data.subjects) {
    const source = subject as PersonalData['subjects'][number] & Record<string, unknown>;
    const statements: Record<string, unknown> = {};
    if (typeof source.wordCount === 'number')
      statements['schema:wordCount'] = [
        statement('schema:wordCount', {
          amount: `+${source.wordCount}`,
          unit: data.definitions.wordCountUnit,
        }),
      ];
    if (typeof source.characterCount === 'number')
      statements['rezics:characterCount'] = [
        statement('rezics:characterCount', {
          amount: `+${source.characterCount}`,
          unit: '1',
        }),
      ];
    if (source.tags.length)
      statements['schema:keywords'] = source.tags.map((key) => {
        const tag = subjects[key];
        if (!tag) throw new Error(`Unknown fixture classification ${key}`);
        return statement('schema:keywords', tag.id);
      });
    if (source.cookTime)
      statements['schema:cookTime'] = [
        statement('schema:cookTime', {
          amount: `+${source.cookTime.value}`,
          unit: source.cookTime.unit === 'wd:Q7727' ? 'http://www.wikidata.org/entity/Q7727' : source.cookTime.unit,
        }),
      ];
    if (source.ingredients)
      statements['schema:recipeIngredient'] = source.ingredients.map((text) =>
        statement('schema:recipeIngredient', { language: 'en', text }),
      );
    if (source.instructions)
      statements['schema:recipeInstructions'] = source.instructions.map((text) =>
        statement('schema:recipeInstructions', { language: 'en', licence: 'CC-BY-4.0', document: fromPlainText(text) }),
      );
    await create(source.key, source.type, source.title, statements);
  }
  const collection = async (title: string, visibility: string) => {
    const result = await nativePersonalJson<{ collection: { id: string } }>(
      await stack.kernel('/v1/collections', personalRequest({ title, visibility }), 'alice'),
      201,
      'POST /v1/collections',
    );
    let after: string | null = null;
    for (const key of data.members.keys) {
      const id = subjects[key]?.id;
      if (!id) throw new Error(`Unknown fixture member ${key}`);
      const added: { member: { id: string } } = await nativePersonalJson(
        await stack.kernel(
          `/v1/collections/${result.collection.id}/members`,
          personalRequest({ subjectId: id, after }),
          'alice',
        ),
        201,
        `POST /v1/collections/${result.collection.id}/members`,
      );
      after = added.member.id;
    }
    return result.collection.id;
  };
  const collectionId = await collection(data.members.collection.title, data.members.collection.initialVisibility);
  const mountId = await collection(`${data.members.zone.title} source`, 'public');
  // Use the native mounted-source contract. Never replace it with a static page
  // that happens to print the same seven subjects, or grant its closed gate.
  const starter = (await import('../../../../packages/definitions/presentation/book/zone.json')).default;
  const configuration = structuredClone(starter);
  configuration.labels.en = data.members.zone.title;
  configuration.scope = []; // This fixture tests mounts, not the released catalogue scope.
  const zone = await nativePersonalJson<{ zone: { id: string } }>(
    await stack.kernel(
      '/v1/zones',
      personalRequest({
        configuration,
        mounts: [mountId],
        visibility: data.members.zone.visibility,
      }),
      'steward',
    ),
    201,
    'POST /v1/zones (native mounted Collection)',
  );
  // Reuse the integrated discussion helper on this same stack, with the
  // moderator as its setup owner. Alice must be an ordinary bannable member.
  const discussion = await createNativeDiscussionFixture({
    ...stack,
    authPersona: (persona) => stack.authPersona(persona === 'alice' ? 'moderator' : persona),
    kernel: (path, init, persona) => stack.kernel(path, init, persona === 'alice' ? 'moderator' : persona),
  });
  await discussion.addMember(discussion.banRealmId, alice.accountId);
  let memberReady = false;
  for (let poll = 0; poll < 8; poll++) {
    const response = await stack.kernel(`/v1/realms/${discussion.banRealmId}`, {}, 'alice');
    if (response.ok) {
      memberReady = true;
      break;
    }
    const body = await response.text();
    if (poll === 7) throw new Error(`Read fixture member Realm: HTTP ${response.status} ${body}`);
    await Bun.sleep(100);
  }
  if (!memberReady) throw new Error('Native fixture membership did not become readable');
  // Bob has no protected membership/grant. The independent grantor can delegate
  // only actual fixture read actions through the normal grants endpoint.
  const grantor = await stack.authPersona('independent-grantor');
  for (const id of [discussion.banRealmId, discussion.banThread.id]) {
    await nativePersonalJson(
      await personalGrant(stack, { route: routeOf(id)!, id }, grantor.accountId, [
        'access:grant',
        id === discussion.banRealmId ? 'realm:read' : 'thread:read',
      ]),
      201,
      `Grant fixture-only read delegation on ${id}`,
    );
  }
  const offer = await nativePersonalJson<{ offer: { id: string } }>(
    await stack.kernel(
      '/v1/offers',
      personalRequest({
        targetSubjectId: subjects[data.commerce.subject]!.id,
        title: data.commerce.title,
        currency: data.commerce.currency.toLowerCase(),
        unitAmountMinor: data.commerce.unitAmountMinor,
        taxCode: 'txcd_10302000',
      }),
      'seller',
    ),
    201,
    'POST /v1/offers',
  );
  await nativePersonalJson(
    await personalGrant(stack, { route: routeOf(offer.offer.id)!, id: offer.offer.id }, alice.accountId, [
      'order:create',
    ]),
    201,
    'Grant fixture offer checkout',
  );
  return {
    definitionsVersion: active.digest,
    accounts: { alice: alice.accountId, bob: bob.accountId },
    subjects,
    choices,
    collectionId,
    zoneId: zone.zone.id,
    offerId: offer.offer.id,
    entitlementTarget: subjects[data.commerce.subject]!.id,
    protected: { realmId: discussion.banRealmId, boardId: discussion.banBoard.id, threadId: discussion.banThread.id },
    image: {
      name: 'personal.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
    },
  };
}

/** Read-only native snapshots. No requested action or browser observation enters this observer. */
export function personalFactsObserver(stack: NativeWebStack) {
  const pool = new Pool({
    connectionString: stack.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000',
  });
  const authPool = new Pool({
    connectionString: stack.authDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000',
  });
  async function snapshot<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    async close() {
      await Promise.all([pool.end(), authPool.end()]);
    },
    async read(accountId: string, fixture: PersonalFixture): Promise<PersonalFacts> {
      return snapshot(async (client) => {
        const rows = async <T extends QueryResultRow>(sql: string, values: unknown[]) =>
          (await client.query<T>(sql, values)).rows;
        const owner = [routeOf(accountId), accountId];
        const entries = await rows<PersonalFacts['entries'][number]>(
          'SELECT subject_id AS "subjectId",state FROM library.entry WHERE route=$1 AND account_id=$2 ORDER BY subject_id LIMIT 8',
          owner,
        );
        const assignments = await rows<{ subjectId: string; labelId: string }>(
          'SELECT subject_id AS "subjectId",label_id AS "labelId" FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL ORDER BY subject_id,label_id LIMIT 32',
          owner,
        );
        const names = await rows<{ id: string; name: string }>(
          'SELECT label_id AS id,normalized_name AS name FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=ANY($3::uuid[]) AND deleted_at IS NULL',
          [...owner, assignments.map((a) => a.labelId)],
        );
        const labels = assignments.map((a) => {
          const label = names.find((n) => n.id === a.labelId);
          if (!label) throw new Error(`Native label assignment ${a.labelId} has no active label`);
          return { subjectId: a.subjectId, name: label.name };
        });
        const copies = await rows<PersonalFacts['copies'][number]>(
          'SELECT subject_id AS "subjectId",kind,status,note FROM library.copy WHERE route=$1 AND account_id=$2 ORDER BY copy_id LIMIT 8',
          owner,
        );
        const sessions = await rows<{ id: string; subjectId: string; unit: string; value: string }>(
          'SELECT session_id AS id,subject_id AS "subjectId",unit,coalesce(amount,"position",completed_unit_count)::text AS value FROM library.progress_session WHERE route=$1 AND account_id=$2 ORDER BY session_id LIMIT 8',
          owner,
        );
        const progress: PersonalFacts['progress'] = [];
        for (const session of sessions) {
          const changes = await rows<{ note: string | null }>(
            "SELECT intent->>'note' AS note FROM library.progress_change WHERE route=$1 AND session_id=$2 ORDER BY change_no DESC LIMIT 1",
            [routeOf(session.id), session.id],
          );
          progress.push({
            subjectId: session.subjectId,
            unit: session.unit,
            value: Number(session.value),
            note: changes[0]?.note ?? '',
          });
        }
        const collectionMembers = await rows<{ id: string }>(
          'SELECT subject_id AS id FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY ordinal_key,member_id LIMIT 8',
          [routeOf(fixture.collectionId), fixture.collectionId],
        );
        const mount = await rows<{ mounts: string[] }>('SELECT mounts FROM zones.zone WHERE route=$1 AND zone_id=$2', [
          routeOf(fixture.zoneId),
          fixture.zoneId,
        ]);
        const zoneMembers: string[] = [];
        for (const id of mount[0]?.mounts ?? [])
          zoneMembers.push(
            ...(
              await rows<{ id: string }>(
                'SELECT subject_id AS id FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY ordinal_key,member_id LIMIT 8',
                [routeOf(id), id],
              )
            ).map((m) => m.id),
          );
        const posts = await rows<{ id: string; revision: string; authorId: string }>(
          'SELECT post_id AS id,head_revision_id AS revision,author_account_id AS "authorId" FROM content.post WHERE route=$1 AND thread_id=$2 AND author_account_id=$3 ORDER BY created_at,post_id LIMIT 16',
          [routeOf(fixture.protected.threadId), fixture.protected.threadId, accountId],
        );
        const revisions = await rows<{ id: string; body: Buffer; mediaIds: string[] }>(
          'SELECT revision_id AS id,body,media_ids AS "mediaIds" FROM content.revision WHERE route=$1 AND thread_id=$2 AND revision_id=ANY($3::uuid[])',
          [routeOf(fixture.protected.threadId), fixture.protected.threadId, posts.map((p) => p.revision)],
        );
        const media = await rows<{ id: string; complete: boolean; sha256: string }>(
          "SELECT media_id AS id,state='available' AS complete,sha256 FROM content.media WHERE route=$1 AND container_id=$2 AND uploader_id=$3 ORDER BY media_id LIMIT 8",
          [routeOf(fixture.protected.threadId), fixture.protected.threadId, accountId],
        );
        const orders = await rows<PersonalFacts['orders'][number]>(
          `SELECT order_id AS id,offer_id AS "offerId",settlement,to_jsonb(o)->>'receipt_id' AS "receiptId" FROM commerce.purchase_order o WHERE route=$1 AND buyer_account_id=$2 ORDER BY created_at,order_id LIMIT 2`,
          owner,
        );
        const entitlements = await rows<PersonalFacts['entitlements'][number]>(
          'SELECT target_subject_id AS "targetId",order_id AS "orderId" FROM commerce.entitlement WHERE route=$1 AND account_id=$2 AND revoked_at IS NULL ORDER BY order_id LIMIT 2',
          owner,
        );
        const passkeys = await authPool.query<{ present: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM passkey WHERE "userId"=$1 AND name=$2) AS present',
          [accountId, 'Personal journey passkey'],
        );
        return {
          entries,
          labels,
          copies,
          progress,
          collectionMembers: collectionMembers.map((m) => m.id),
          zoneMembers,
          media: media.map((m) => ({
            ...m,
            attachedThreadId: revisions.some((r) => r.mediaIds.includes(m.id)) ? fixture.protected.threadId : null,
            downloadHref: `${stack.web}/media/${m.id}/original`,
          })),
          posts: posts.map((p) => {
            const revision = revisions.find((r) => r.id === p.revision);
            const doc = revision ? parseStoredDocument(revision.body.toString('utf8')) : null;
            if (!doc) throw new Error(`Native post ${p.id} has no readable current revision`);
            return { authorId: p.authorId, text: documentText(doc) };
          }),
          orders,
          entitlements,
          securitySettingChanged: passkeys.rows[0]?.present === true,
        };
      });
    },
  };
}
