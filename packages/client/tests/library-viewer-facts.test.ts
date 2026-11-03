import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

type LibraryPage = NonNullable<Awaited<ReturnType<KernelClient['libraryEntries']['get']>>['data']>;
type CollectionPage = Extract<
  NonNullable<Awaited<ReturnType<ReturnType<KernelClient['collections']>['members']['get']>>['data']>,
  { members: unknown[] }
>;
type Facts = NonNullable<LibraryPage['viewerFacts']>;
expectTypeOf<CollectionPage['viewerFacts']>().toEqualTypeOf<Facts | undefined>();
expectTypeOf<Facts['state']>().toEqualTypeOf<'current'>();
expectTypeOf<Facts['rows'][number]['entry']['state']>().toEqualTypeOf<'present' | 'absent' | 'unavailable'>();
expectTypeOf<Facts['rows'][number]['vote']['state']>().toEqualTypeOf<'present' | 'absent' | 'unavailable'>();

test('Library and readable Collection pages preserve optional current viewer facts', async () => {
  const viewerFacts: Facts = {
    state: 'current',
    question: null,
    rows: [{ rowKey: '0', subjectId: 'subject', entry: { state: 'absent' }, vote: { state: 'unavailable', reason: 'scope' } }],
  };
  for (const facts of [viewerFacts, undefined]) {
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input: RequestInfo | URL) => Response.json({
        ...(String(input).includes('/collections/') ? { members: [] } : { libraryEntries: [] }),
        next: null,
        ...(facts ? { viewerFacts: facts } : {}),
      })) as typeof fetch,
    });
    const library = await client.libraryEntries.get();
    const collection = await client.collections({ collectionId: 'collection' }).members.get();
    expect(library.data?.viewerFacts).toEqual(facts);
    expect(collection.data && 'members' in collection.data ? collection.data.viewerFacts : null).toEqual(facts);
  }
});
