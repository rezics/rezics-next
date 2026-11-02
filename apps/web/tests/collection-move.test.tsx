import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import { createKernelClient } from '@rezics/client';
import recording from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => false,
  sessionSubject: () => 'owner',
  viewerCredential: () => 'Bearer owner',
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/source' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
]) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window],
  });
}
const { createRoot } = await import('react-dom/client');
const reads = await import('../src/library/collection-move-read');
const destinationReads = await import('../src/library/collection-read');
const { CollectionMoveChooser } = await import('../src/library/collection-move-chooser');
import type { CollectionMoveChoice } from '../src/library/collection-move-chooser';
const { transferCollectionMembersRecord } = await import('../src/library/collection-commands');
const { m } = await import('../src/paraglide/messages.js');
const request = new Request('https://site.test/collection');
let nativeRevision = 7,
  unsupported = false;
const calls: Request[] = [];
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const url = new URL(call.url);
    if (call.method === 'POST')
      return unsupported
        ? Response.json({ code: 'collection_move_unsupported' }, { status: 409 })
        : Response.json({
            source: { ...recording.collection, revision: 12 },
            destination: { ...recording.collection, revision: 8 },
            members: [],
          });
    if (url.pathname === '/v1/collections')
      return Response.json({
        collections: url.searchParams.has('cursor')
          ? [{ ...recording.collection, id: 'destination', title: 'Destination', membershipKind: 'curated' }]
          : [
              { ...recording.collection, id: 'source', membershipKind: 'curated' },
              { ...recording.collection, id: 'dynamic', membershipKind: 'dynamic' },
            ],
        next: url.searchParams.has('cursor') ? null : 'destinations-page-2',
      });
    if (url.pathname.endsWith('/members'))
      return Response.json({
        members: [{ ...members.members[0]!, id: url.searchParams.has('cursor') ? 'second' : 'first' }],
        next: url.searchParams.has('cursor') ? null : 'members-page-2',
      });
    return Response.json({
      collection: {
        ...recording.collection,
        id: 'destination',
        curatorAccountId: 'owner',
        revision: nativeRevision,
        membershipKind: 'curated',
      },
    });
  },
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const settle = (work: () => void = () => {}) =>
  act(async () => {
    work();
    await Bun.sleep(10);
  });
function props(element: Element) {
  return Object.entries(element).find(([key]) => key.startsWith('__reactProps$'))![1] as {
    onChange: (event: { target: { value: string } }) => void;
  };
}

test('destination and occurrence pages lead to one native move with both revisions, exact selection and chosen anchor', async () => {
  spyOn(reads, 'readCollectionMoveChoices').mockImplementation(({ data }) =>
    reads.loadMoveChoices(client, request, {}, data),
  );
  spyOn(reads, 'readCollectionMovePlacements').mockImplementation(({ data }) =>
    reads.loadMovePlacements(client, request, {}, data),
  );
  const destinationRead = spyOn(destinationReads, 'readCollectionDestination').mockImplementation(({ data }) =>
    destinationReads.loadCollectionDestination(client, request, {}, data),
  );
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let choice: CollectionMoveChoice | null = null;
  let current = true;
  try {
    await settle(() =>
      root.render(
        createElement(CollectionMoveChooser, {
          sourceId: 'source',
          disabled: false,
          current: () => current,
          onChange: (value) => {
            choice = value;
          },
        }),
      ),
    );
    expect(host.querySelectorAll('option')).toHaveLength(1);
    await settle(() => (host.querySelector('button') as HTMLButtonElement).click());
    expect(host.textContent).toContain('Destination');
    await settle(() => props(host.querySelector('select')!).onChange({ target: { value: 'destination' } }));
    expect(choice).toEqual({
      destination: { id: 'destination', title: recording.collection.title, revision: 7 },
      after: null,
    });
    const more = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_collection_move_more_members(),
    )!;
    await settle(() => more.click());
    await settle(() => props(host.querySelectorAll('select')[1]!).onChange({ target: { value: 'second' } }));
    expect(choice!.after).toBe('second');
    const input = {
      collectionId: 'source',
      revision: 11,
      memberIds: ['selected-2', 'selected-1'],
      destinationCollectionId: choice!.destination.id,
      destinationRevision: choice!.destination.revision,
      after: choice!.after,
      idempotencyKey: '10203040-5060-4070-8090-102030405060',
    };
    expect(await transferCollectionMembersRecord(client, request, {}, input)).toEqual({
      ok: true,
      revision: 12,
      destinationRevision: 8,
    });
    const write = calls.find((call) => call.method === 'POST')!;
    expect(await write.json()).toEqual({
      revision: 11,
      memberIds: input.memberIds,
      destinationCollectionId: 'destination',
      destinationRevision: 7,
      after: 'second',
    });
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer owner')).toBe(true);
    expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/members'))).toHaveLength(2);
    unsupported = true;
    expect(await transferCollectionMembersRecord(client, request, {}, input)).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    nativeRevision++;
    await settle(() => props(host.querySelector('select')!).onChange({ target: { value: 'destination' } }));
    expect(choice!.destination.revision).toBe(8);
    current = false;
    await settle(() => props(host.querySelectorAll('select')[1]!).onChange({ target: { value: 'first' } }));
    expect(choice!.after).toBeNull();
    current = true;
    let resolve!: (value: CollectionMoveChoice['destination']) => void;
    const delayed = new Promise<CollectionMoveChoice['destination']>((done) => {
      resolve = done;
    });
    destinationRead.mockImplementationOnce(() => delayed);
    const beforeRetirement = calls.length;
    await settle(() => props(host.querySelector('select')!).onChange({ target: { value: 'destination' } }));
    current = false;
    await settle(() => resolve({ id: 'destination', title: 'Destination', revision: 8 }));
    expect(calls).toHaveLength(beforeRetirement);
    expect(choice).toBeNull();
  } finally {
    await settle(() => root.unmount());
    host.remove();
  }
});

test('placement reads reject a stale destination revision rather than offering a false empty destination', async () => {
  await expect(
    reads.loadMovePlacements(client, request, {}, { collectionId: 'destination', revision: 1 }),
  ).rejects.toThrow('Move destination changed');
});
