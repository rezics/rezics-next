import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { WORK_CONTENTS_COST } from '../src/modules/work-contents/read-contract.ts';

test('Reader routes expose bounded, typed Work contents and exact chapter bodies to web consumers', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedReader = async () => {
    const page = await client.v1.works({ id: '00000000-0000-4000-8000-000000000001' }).contents.get({
      query: { language: 'en', limit: 2, parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' },
    });
    const next: string | null | undefined = page.data?.nextCursor;
    const occurrence: string | undefined = page.data?.items[0]?.occurrence;
    const chapter = await client.v1.chapters({ id: '00000000-0000-4000-8000-000000000003' }).get({
      query: { language: 'en', revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004' },
    });
    const body: Record<string, any> | undefined = chapter.data?.content.body;
    const previous: string | null | undefined = chapter.data?.previous;
    return { next, occurrence, body, previous };
  };
  expect(typedReader).toBeFunction();
  expect(WORK_CONTENTS_COST).toEqual({ pageSize: 20, bodyBytes: 1024 * 1024,
    navigationCandidates: 20 });
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/work-contents' },
  account: {} as never, access: {} as never });
  const paths = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(paths).toContain('/v1/works/:id/contents');
  expect(paths).toContain('/v1/chapters/:id');
});
