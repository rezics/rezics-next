import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { createBoard } from '../../src/content/board-create.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { realmBoardWorld } from './realm-board-create-support.ts';

test('a current reviewer selects one exact native destination and sparse pages retain their raw frontier', async () => {
  const world = await realmBoardWorld();
  try {
    const subjectId = await world.subject('skos:Concept', world.schemeId);
    const reviewConcept = await world.subject('skos:Concept', world.schemeId);
    const reviewer = await world.person();
    const deadline = Date.now() + 60_000;
    const access = world.kernel.testAccess;
    const actor = await access.authenticate(world.owner.bearer, { pool: world.db.pool, deadline });
    const dependencies = {
      clock: () => new Date(),
      pool: world.db.pool,
      access,
      routeKey: world.routeKey,
      realmParticipation: createRealmParticipationCheck({
        clock: () => new Date(),
        pool: world.db.pool,
        access,
        deadlineNow: () => Date.now(),
      }),
    };
    const created = await createBoard(
      dependencies,
      actor,
      {
        realmId: world.realm.realmId,
        conceptId: reviewConcept,
        title: 'Current reviews',
        visibility: 'published',
        purpose: 'reviews',
      },
      { deadline, idempotencyKey: crypto.randomUUID() },
    );
    const boardId = created.value.boardId;
    const boardResource = { route: routeOf(boardId)!, id: boardId };
    await world.checked('POST', '/v1/roleGrants', {
      resource: { route: routeOf(world.realm.realmId)!, id: world.realm.realmId },
      subject: { kind: 'account', id: reviewer.accountId },
      role: 'community.realm.member',
      valid: '(,)',
    });
    await world.checked('POST', '/v1/grants', {
      resource: boardResource,
      subject: { kind: 'account', id: reviewer.accountId },
      actions: ['board:read', 'thread:create'],
      valid: '(,)',
    });
    const endpoint = (realmId: string, subject: string, extra = '') =>
      `/v1/realms/${realmId}/review-destinations?subjectId=${encodeURIComponent(subject)}${extra}`;
    const selected = await world.call('GET', endpoint(world.realm.realmId, subjectId), undefined, {
      bearer: reviewer.bearer,
    });
    expect(selected.response.status).toBe(200);
    expect(selected.value).toMatchObject({
      state: 'choices',
      viewer: { state: 'current' },
      context: { subject: { id: subjectId }, realm: { id: world.realm.realmId } },
      items: [
        {
          id: boardId,
          purpose: 'reviews',
          actions: { createReview: 'allowed' },
          native: { kind: 'review', boardId, subjectIds: [subjectId] },
        },
      ],
      next: null,
    });

    const native = selected.value.items[0].native;
    const written = await world.call(
      'POST',
      '/v1/threads',
      {
        kind: native.kind,
        title: 'Selected review',
        body: fromPlainText('The composer retained the selected native operands.'),
        licence: 'CC-BY-4.0',
        boardId: native.boardId,
        subjectIds: native.subjectIds,
        visibility: 'published',
      },
      { bearer: reviewer.bearer },
    );
    expect(written.response.status).toBe(201);
    expect(written.value.thread).toMatchObject({ kind: 'review', boardId, subjectIds: [subjectId] });

    await world.checked(
      'POST',
      '/v1/grants:revoke',
      {
        resource: boardResource,
        subject: { kind: 'account', id: reviewer.accountId },
        actions: ['thread:create'],
        valid: '(,)',
      },
      200,
    );
    const inspected = await world.call(
      'GET',
      endpoint(world.realm.realmId, subjectId, '&boardId=' + encodeURIComponent(boardId)),
      undefined,
      { bearer: reviewer.bearer },
    );
    expect(inspected.response.status).toBe(200);
    expect(inspected.value).toMatchObject({ state: 'denied', viewer: { state: 'current' }, items: [] });
    const revokedWrite = await world.call(
      'POST',
      '/v1/threads',
      {
        kind: native.kind,
        title: 'Selected review',
        body: fromPlainText('The composer retained the selected native operands.'),
        licence: 'CC-BY-4.0',
        boardId: native.boardId,
        subjectIds: native.subjectIds,
        visibility: 'published',
      },
      { bearer: reviewer.bearer },
    );
    expect(revokedWrite.response.status).toBe(403);

    const sparseRealm = (
      await world.checked('POST', '/v1/realms', {
        spaceId: world.realm.spaceId,
        title: 'Sparse destination Realm',
        summary: 'Sparse destination Realm',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      })
    ).realm;
    await world.checked('POST', '/v1/roleGrants', {
      resource: { route: routeOf(sparseRealm.realmId)!, id: sparseRealm.realmId },
      subject: { kind: 'account', id: reviewer.accountId },
      role: 'community.realm.member',
      valid: '(,)',
    });
    await world.checked('PUT', `/v1/realms/${sparseRealm.realmId}/boardScheme`, { schemeId: world.schemeId }, 200, {
      headers: { 'if-match': JSON.stringify(sparseRealm.headRevisionId) },
    });
    let hiddenBoardId = '';
    for (let index = 0; index < 21; index++) {
      const conceptId = await world.subject('skos:Concept', world.schemeId);
      const hidden = await createBoard(
        dependencies,
        actor,
        {
          realmId: sparseRealm.realmId,
          conceptId,
          title: `Protected review ${index}`,
          visibility: 'protected',
          purpose: 'reviews',
        },
        { deadline, idempotencyKey: crypto.randomUUID() },
      );
      if (index === 0) hiddenBoardId = hidden.value.boardId;
    }
    const first = await world.call('GET', endpoint(sparseRealm.realmId, subjectId), undefined, {
      bearer: reviewer.bearer,
    });
    expect(first.response.status).toBe(200);
    expect(first.value).toMatchObject({ state: 'sparse', items: [], next: expect.any(String) });
    const later = await world.call(
      'GET',
      endpoint(sparseRealm.realmId, subjectId, `&cursor=${encodeURIComponent(first.value.next)}`),
      undefined,
      { bearer: reviewer.bearer },
    );
    expect(later.response.status).toBe(200);
    expect(later.value).toMatchObject({ state: 'exhausted', items: [], next: null });
    const hiddenRead = await world.call(
      'GET',
      endpoint(sparseRealm.realmId, subjectId, '&boardId=' + encodeURIComponent(hiddenBoardId)),
      undefined,
      { bearer: reviewer.bearer },
    );
    expect(hiddenRead.response.status).toBe(404);
    const rebound = await world.call(
      'GET',
      endpoint(sparseRealm.realmId, reviewConcept, `&cursor=${encodeURIComponent(first.value.next)}`),
      undefined,
      { bearer: reviewer.bearer },
    );
    expect(rebound.response.status).toBe(200);
    expect(rebound.value).toMatchObject({ state: 'expired', items: [], next: null });

    const protectedRealm = (
      await world.checked('POST', '/v1/realms', {
        spaceId: world.realm.spaceId,
        title: 'Protected destination Realm',
        summary: 'Protected destination Realm',
        visibility: 'protected',
        contextId: GLOBAL_CONTEXT,
      })
    ).realm;
    const concealed = await world.call('GET', endpoint(protectedRealm.realmId, subjectId), undefined, {
      bearer: reviewer.bearer,
    });
    expect(concealed.response.status).toBe(404);
  } finally {
    await world.close();
  }
});
