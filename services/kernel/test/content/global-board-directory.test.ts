import { afterAll, beforeAll, expect, test } from 'bun:test';
import { deriveAccess } from '../../src/access/derived-access.ts';
import type { GlobalBoardDirectoryResponse } from '../../src/content/global-board-directory.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { testTokens } from '../support/test-kernel.ts';
import { realmBoardWorld } from './realm-board-create-support.ts';
import pageGlobalBoards from '../../src/content/global-board-directory-page.sql';
import { observeSql } from './support/sql-observer.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;
const tokens = testTokens();
const expected = { discussion: [] as string[], reviews: [] as string[] };
const scope = (purpose: string | null = null, limit = 1) => ({
  route: 'GET /v1/boards',
  viewer: null,
  query: { purpose, limit },
});
async function get(query = '', app: Pick<typeof world.kernel, 'handle'> = world.kernel, bearer?: string) {
  return app.handle(
    new Request('http://kernel.test/v1/boards' + query, {
      headers: bearer ? { authorization: 'Bearer ' + bearer } : {},
    }),
  );
}
beforeAll(async () => {
  world = await realmBoardWorld();
  await world.checked('POST', '/v1/grants', {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: world.owner.accountId },
    actions: ['board:create'],
    valid: '(,)',
  });
  for (const purpose of ['discussion', 'reviews'] as const) {
    for (let index = 0; index < 2; index++) {
      const result = await world.checked('POST', '/v1/boards', {
        conceptId: world.conceptId,
        title: 'Global ' + purpose,
        purpose,
        visibility: 'published',
      });
      expected[purpose].push(result.board.id as string);
    }
    await world.checked('POST', '/v1/boards', {
      conceptId: world.conceptId,
      title: 'Private ' + purpose,
      purpose,
      visibility: 'protected',
    });
  }
  await world.board();
}, 60_000);
afterAll(async () => {
  await world?.close();
});

test('anonymous and governance readers discover actual empty Global boards by purpose with signed continuation', async () => {
  const operation = openApiDocument(world.kernel).paths?.['/v1/boards']?.get;
  expect(operation).toMatchObject({ 'x-exposure': 'public', 'x-action': 'board:read' });
  expect(operation).not.toHaveProperty('x-resource-types');
  for (const purpose of ['discussion', 'reviews'] as const) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = '?purpose=' + purpose + '&limit=1' + (cursor ? '&cursor=' + cursor : '');
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(response.headers.has(SESSION_HEADER)).toBe(true);
      const page = (await response.json()) as GlobalBoardDirectoryResponse;
      expect(Object.keys(page).sort()).toEqual(['boards', 'next']);
      expect(await (await get(query, world.kernel, world.owner.bearer)).json()).toEqual(page);
      for (const board of page.boards) {
        expect(board).toMatchObject({
          realmId: null,
          route: routeOf(board.id),
          purpose,
          visibility: 'published',
          availability: 'available',
        });
        expect(
          await (await world.kernel.handle(new Request('http://kernel.test/v1/boards/' + board.id))).json(),
        ).toEqual({ board });
        ids.push(board.id);
      }
      cursor = page.next;
    } while (cursor);
    expect(ids).toEqual([...expected[purpose]].sort());
  }
  const all = (await (await get()).json()) as GlobalBoardDirectoryResponse;
  expect(all.boards.map((board) => board.id).sort()).toEqual([...expected.discussion, ...expected.reviews].sort());
});

test('strict native query bounds and endpoint, normalized query and definition cursor bindings reject misuse', async () => {
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?purpose=other', '?realmId=' + world.realm.realmId])
    expect((await get(query)).status).toBe(400);
  const first = (await (await get('?purpose=discussion&limit=1')).json()) as GlobalBoardDirectoryResponse;
  expect(first.next).toBeString();
  for (const query of ['purpose=reviews&limit=1', 'purpose=discussion&limit=2'])
    expect(await (await get('?' + query + '&cursor=' + first.next)).json()).toMatchObject({ code: 'invalid_cursor' });
  const decoded = await decodeListCursor(tokens, scope('discussion'), first.next!, new Date());
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Directory cursor did not decode');
  for (const [binding, epoch] of [
    [{ ...scope('discussion'), route: 'GET /v1/sitemap/boards' }, 1],
    [scope('discussion'), 2],
  ] as const) {
    const cursor = await encodeListCursor(tokens, binding, { epoch, after: decoded.after }, new Date());
    expect(await (await get('?purpose=discussion&limit=1&cursor=' + cursor)).json()).toMatchObject({
      code: 'invalid_cursor',
    });
  }
});

test('current source checks exclude taken-down candidates, bound a sparse page to four and recheck FINAL', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-7000-8000-ffff0000000${i}`);
  for (const id of ids)
    await world.db.admin.query(
      `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES (65535,$1,$2,'Current directory source','published',1,$1)`,
      [id, world.conceptId],
    );
  const base = world.kernel.testAccess;
  const preparations = new Map<string, number>();
  const access = deriveAccess(base, {
    async prepare(actor, action, resource, context) {
      if (action === 'board:read' && ids.includes(resource.id)) {
        expect(actor.kind).toBe('anonymous');
        const count = (preparations.get(resource.id) ?? 0) + 1;
        preparations.set(resource.id, count);
        // The first four become hidden after the range seek. The last changes only at FINAL.
        if (resource.id !== ids[4] || count === 2)
          await world.db.admin.query(
            "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=65535 AND board_id=$1",
            [resource.id],
          );
      }
      return base.prepare?.(actor, action, resource, context);
    },
  });
  const app = createKernel({ pool: world.db.pool, access, tokens, routeKey: world.routeKey });
  const observer = observeSql(world.db.pool);
  try {
    const start = await encodeListCursor(tokens, scope(), { epoch: 1, after: [65534, newId(65534)] }, new Date());
    const first = (await (await get('?limit=1&cursor=' + start, app)).json()) as GlobalBoardDirectoryResponse;
    expect(first.boards).toEqual([]);
    expect(first.next).toBeString();
    const decoded = await decodeListCursor(tokens, scope(), first.next!, new Date());
    expect(decoded).toMatchObject({ ok: true, after: [65535, ids[3]] });
    const second = (await (await get('?limit=1&cursor=' + first.next, app)).json()) as GlobalBoardDirectoryResponse;
    expect(second).toEqual({ boards: [], next: null });
    expect(preparations.get(ids[4]!)).toBe(2);
    const ranges = observer.records.filter((record) => record.statement === pageGlobalBoards.sql);
    expect(ranges).toHaveLength(2);
    expect(ranges.map((record) => record.parameters[pageGlobalBoards.params.indexOf('limit')])).toEqual([4, 4]);
  } finally {
    await observer.close();
  }
});
