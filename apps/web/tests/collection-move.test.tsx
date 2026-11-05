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
  unsupported = false,
  destinationKind: 'curated' | 'dynamic' = 'curated',
  destinationIdentity = 'destination',
  emptyCatalogue = false;
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
    if (url.pathname === '/v1/collections' && emptyCatalogue)
      return Response.json({
        collections: [
          { ...recording.collection, id: 'source', membershipKind: 'curated' },
          { ...recording.collection, id: 'dynamic', membershipKind: 'dynamic' },
        ],
        next: null,
      });
    if (url.pathname === '/v1/collections')
      return Response.json({
        collections:
          url.searchParams.get('cursor') === 'destinations-page-3'
            ? [{ ...recording.collection, id: 'destination', title: 'Destination', membershipKind: 'curated' }]
            : url.searchParams.get('cursor') === 'destinations-page-2'
              ? []
              : [
                  { ...recording.collection, id: 'source', membershipKind: 'curated' },
                  { ...recording.collection, id: 'dynamic', membershipKind: 'dynamic' },
                ],
        next:
          url.searchParams.get('cursor') === 'destinations-page-3'
            ? null
            : url.searchParams.get('cursor') === 'destinations-page-2'
              ? 'destinations-page-3'
              : 'destinations-page-2',
      });
    if (url.pathname.endsWith('/members')) {
      const cursor = url.searchParams.get('cursor');
      const occurrence = (id: string) => ({
        ...members.members[0]!,
        id,
        subject: { ...members.members[0]!.subject!, id: 'repeated-subject' },
      });
      return Response.json({
        members:
          cursor === 'anchors-page-2'
            ? []
            : cursor === 'anchors-page-3'
              ? [occurrence('duplicate-a'), occurrence('duplicate-b')]
              : [occurrence('anchor-first')],
        next: cursor === 'anchors-page-2' ? 'anchors-page-3' : cursor === 'anchors-page-3' ? null : 'anchors-page-2',
      });
    }
    return Response.json({
      collection: {
        ...recording.collection,
        id: destinationIdentity,
        curatorAccountId: 'owner',
        revision: nativeRevision,
        membershipKind: destinationKind,
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

test('bounded deep destination and placement browsing preserves duplicate occurrences and one native move', async () => {
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
          key: 'empty-catalogue',
          sourceId: 'source',
          disabled: false,
          current: () => current,
          onChange: (value) => {
            choice = value;
          },
        }),
      ),
    );
    expect(host.querySelectorAll('[data-move-destination]')).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('button')!.textContent).toBe(
      m.library_collection_move_more_destinations(),
    );
    await settle(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelectorAll('[data-move-destination]')).toHaveLength(0);
    await settle(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelectorAll('[data-move-destination]')).toHaveLength(1);
    await settle(() => host.querySelector<HTMLButtonElement>('[data-move-destination="destination"]')!.click());
    expect(choice).toEqual({
      destination: { id: 'destination', title: recording.collection.title, revision: 7 },
      after: null,
      anchor: null,
    });
    const more = () =>
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === m.library_collection_move_more_members(),
      )!;
    await settle(() => more().click());
    expect(host.querySelectorAll('[data-move-anchor]')).toHaveLength(0);
    expect(host.textContent).toContain(m.library_collection_move_no_anchors());
    await settle(() => more().click());
    expect(host.querySelectorAll('[data-move-anchor]')).toHaveLength(2);
    await settle(() => host.querySelector<HTMLButtonElement>('[data-move-anchor="duplicate-b"]')!.click());
    expect(choice!.after).toBe('duplicate-b');
    const originalChoice = choice!;
    const fixtureLabel = members.members[0]!.subject!.label;
    expect(choice!.anchor).toEqual({
      id: 'duplicate-b',
      title: typeof fixtureLabel === 'string' ? fixtureLabel : fixtureLabel?.value,
      page: 3,
      position: 2,
    });
    const input = {
      collectionId: 'source',
      revision: 11,
      memberIds: ['selected-2', 'selected-1'],
      destinationCollectionId: originalChoice.destination.id,
      destinationRevision: originalChoice.destination.revision,
      after: originalChoice.after,
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
      after: 'duplicate-b',
    });
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer owner')).toBe(true);
    expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/members'))).toHaveLength(3);
    unsupported = true;
    expect(await transferCollectionMembersRecord(client, request, {}, input)).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    unsupported = false;
    destinationKind = 'dynamic';
    expect(await destinationReads.loadCollectionDestination(client, request, {}, 'destination')).toBeNull();
    destinationKind = 'curated';
    destinationIdentity = 'different-identity';
    expect(await destinationReads.loadCollectionDestination(client, request, {}, 'destination')).toBeNull();
    destinationIdentity = 'destination';
    const placement = host.querySelector<HTMLElement>('[data-placement-browse]')!;
    await settle(() =>
      [...placement.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === m.library_collection_move_previous())!
        .click(),
    );
    expect(placement.querySelectorAll('[data-move-anchor]')).toHaveLength(0);
    expect(host.querySelector('[data-selected-move-anchor]')?.textContent).toContain('duplicate-b');
    nativeRevision++;
    await settle(() =>
      [...placement.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === m.library_collection_move_more_members())!
        .click(),
    );
    expect(host.textContent).toContain(m.library_collection_move_destination_changed());
    expect(host.querySelector('[data-selected-move-anchor]')).toBeNull();
    expect(choice).toBeNull();
    current = false;
    current = true;
    let resolve!: (value: CollectionMoveChoice['destination']) => void;
    const delayed = new Promise<CollectionMoveChoice['destination']>((done) => {
      resolve = done;
    });
    destinationRead.mockImplementationOnce(() => delayed);
    const beforeRetirement = calls.length;
    await settle(() => host.querySelector<HTMLButtonElement>('[data-move-destination="destination"]')!.click());
    current = false;
    await settle(() => resolve({ id: 'destination', title: 'Destination', revision: 8 }));
    expect(calls).toHaveLength(beforeRetirement);
    expect(choice).toBeNull();
    current = true;
    emptyCatalogue = true;
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
    expect(host.textContent).toContain(m.library_collection_move_no_destinations());
    expect(host.querySelector<HTMLButtonElement>(`[data-move-destination="dynamic"]`)).toBeNull();
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
