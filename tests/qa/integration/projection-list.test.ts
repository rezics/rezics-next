import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { PROJECTION_COST, PROJECTION_CREATION_QUOTA, projectionKey } from '../../../services/main/src/modules/projection/schema.ts';

interface Page { items: { id: string }[]; nextCursor: string | null; sourcePosition: object }
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}

test('hidden subjects and hidden projection rows disclose neither identities nor continuation', async () => {
  const stack = await startMediaStack('projection-list');
  try {
    const owner = await stack.member('owner'), stranger = await stack.member('stranger');
    const work = await stack.publicWork(owner.actor);
    await owner.grant(`work:read:${work.work}`, 'work.read');
    await owner.grant('semantic:create:root', 'semantic.change');
    await owner.grant('projection:create:root', 'projection.create');
    const semantic = async (type: string, visible = true) => {
      const saved = await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
        state: { component: 'resource', types: [type], properties: visible ? [{
          predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: work.work },
        }] : [] },
      }), 201);
      if (!visible) await owner.grant(`semantic:read:${saved.component}`, 'semantic.read');
      return saved.component;
    };
    const subject = await semantic('https://rezics.com/vocab/Character');
    const hiddenSubject = await semantic('https://rezics.com/vocab/Character', false);
    const emptySubject = await semantic('https://rezics.com/vocab/Character');
    const secret = await semantic('https://schema.org/Event', false);
    const publicFrames = await Promise.all(['https://schema.org/Event', 'https://schema.org/Event',
      'https://rezics.com/vocab/NarrativeContinuity'].map(type => semantic(type)));
    const project = async (on: string, frames: string[]) => (await json<{ projection: { id: string } }>(
      await owner.send('POST', '/v1/projections', { subject: on, frames, actingSubject: owner.actor }), 201)).projection.id;
    await project(hiddenSubject, [publicFrames[0]!]);
    await project(hiddenSubject, [publicFrames[1]!]);
    // Hidden rows before, between and after disclosed rows cannot become cursors.
    await project(subject, [secret]);
    const first = await project(subject, [publicFrames[0]!]);
    await project(subject, [secret, work.work]);
    const second = await project(subject, [publicFrames[1]!]);
    await project(subject, [secret, publicFrames[2]!].sort());
    const read = (reader: typeof owner | null, on: string, suffix = '') => {
      const path = `/v1/projections?subject=${encodeURIComponent(on)}&limit=1${suffix}`;
      return reader ? reader.read(path) : stack.call('GET', path);
    };
    const nativeList = ProjectionStore.prototype.list;
    let hiddenProbes = 0;
    ProjectionStore.prototype.list = function (on, after, limit) {
      if (on === hiddenSubject) hiddenProbes++;
      return nativeList.call(this, on, after, limit);
    };
    try {
      for (const reader of [null, stranger]) {
        const empty = await json<Page>(await read(reader, emptySubject));
        expect(await json<Page>(await read(reader, hiddenSubject))).toEqual(empty);
        expect(await json<Page>(await read(reader, hiddenSubject, `&cursor=${randomUUID()}`))).toEqual(empty);
        expect(await json<Page>(await read(reader, `https://rezics.com/id/${randomUUID()}`))).toEqual(empty);
        const page = await json<Page>(await read(reader, subject));
        expect(page).toMatchObject({ items: [{ id: first }] });
        expect(page.nextCursor).toBeString();
        expect(page.nextCursor).not.toContain(first.slice(-36));
        expect(await json<Page>(await read(reader, subject, `&cursor=${page.nextCursor}`)))
          .toMatchObject({ items: [{ id: second }], nextCursor: null });
      }
      expect(hiddenProbes).toBe(0);
    } finally { ProjectionStore.prototype.list = nativeList; }

    // Interrupted and undisclosed reservations cannot consume the request's graph budget.
    const store = new ProjectionStore(stack.accessPool);
    const admission = (await stack.accessPool.query<{ admission_id: string }>(
      'SELECT admission_id FROM access.projection_identity WHERE projection = $1', [first.slice(-36)])).rows[0]!.admission_id;
    for (let i = 0; i < 12; i++) await store.reserve({ ...projectionKey(emptySubject,
      [publicFrames[0]!, `https://rezics.com/id/${randomUUID()}`]), admission });
    const last = await project(emptySubject, [publicFrames[0]!]);
    for (const selector of [`subject=${encodeURIComponent(emptySubject)}`,
      `frame=${encodeURIComponent(publicFrames[0]!)}&subject=${encodeURIComponent(emptySubject)}`]) {
      let cursor: string | null = null, found = false, pages = 0;
      const nativeFrameList = ProjectionStore.prototype.listByFrame;
      let probes = 0;
      ProjectionStore.prototype.list = function (...args) { probes++; return nativeList.apply(this, args); };
      ProjectionStore.prototype.listByFrame = function (...args) { probes++; return nativeFrameList.apply(this, args); };
      try {
        do {
          probes = 0;
          const response = await stack.call('GET', `/v1/projections?${selector}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
          const page = await json<Page>(response);
          expect(probes).toBeLessThanOrEqual(PROJECTION_COST.visibilityBatches);
          expect(page.items.every(item => item.id === last)).toBe(true);
          found ||= page.items.some(item => item.id === last);
          cursor = page.nextCursor;
          expect(++pages).toBeLessThan(10);
        } while (cursor);
        expect(found).toBe(true);
      } finally { ProjectionStore.prototype.list = nativeList; ProjectionStore.prototype.listByFrame = nativeFrameList; }
    }
    const ownerPrincipal = (await stack.accessPool.query<{ principal_id: string }>(
      'SELECT principal_id FROM access.admission WHERE id = $1', [admission])).rows[0]!.principal_id;
    await stack.accessPool.query('UPDATE access.projection_creator_quota SET reservations = $2 WHERE principal_id = $1',
      [ownerPrincipal, PROJECTION_CREATION_QUOTA - 1]);
    const fresh = await semantic('https://rezics.com/vocab/Character');
    const raced = await Promise.all(publicFrames.slice(0, 2).map(frame => owner.send('POST', '/v1/projections',
      { subject: fresh, frames: [frame], actingSubject: owner.actor })));
    expect(raced.map(response => response.status).sort()).toEqual([201, 429]);
    expect(await json(await owner.send('POST', '/v1/projections',
      { subject, frames: [publicFrames[0]!], actingSubject: owner.actor }), 200)).toMatchObject({ projection: { id: first } });
    expect((await store.reserve({ ...projectionKey(subject, [publicFrames[0]!]), admission })).projection).toBe(first);
    await owner.grant('relation:create:root', 'relation.change');
    const definition = await json<{ component: string; revision: string }>(await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: owner.actor, expectedHead: null,
      state: { component: 'definition', kind: 'relation', roles: ['left', 'right'].map(key =>
        ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
    }), 201);
    await owner.grant(`semantic:read:${definition.component}`, 'semantic.read');
    const refusedKey = randomUUID();
    const refuseParticipant = () => owner.send('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', expectedHead: null, definition: definition.revision, actingSubject: owner.actor,
      participations: [{ role: 'left', participant: { kind: 'resource', ref: first } },
        { role: 'right', participant: { kind: 'resource', ref: subject } }],
    }, refusedKey);
    for (let i = 0; i < 2; i++) expect(await json(await refuseParticipant(), 422))
      .toMatchObject({ code: 'projection_participant_refused' });
    expect((await stack.accessPool.query<{ state: string }>('SELECT state FROM access.admission WHERE idempotency_key = $1',
      [refusedKey])).rows[0]!.state).toBe('sealed');
  } finally { await stack.stop(); }
}, 240_000);
