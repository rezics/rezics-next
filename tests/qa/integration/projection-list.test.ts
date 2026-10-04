import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';

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
        expect(page).toMatchObject({ items: [{ id: first }], nextCursor: first.slice(-36) });
        expect(await json<Page>(await read(reader, subject, `&cursor=${page.nextCursor}`)))
          .toMatchObject({ items: [{ id: second }], nextCursor: null });
      }
      expect(hiddenProbes).toBe(0);
    } finally { ProjectionStore.prototype.list = nativeList; }
  } finally { await stack.stop(); }
}, 240_000);
