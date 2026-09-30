import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { WORK_ACTIVITY_COST } from '../src/modules/work-activity/read-contract.ts';

test('Work activity exposes typed Discussion and History pages on MainApp', async () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedReads = async () => {
    const work = client.v1.works({ id: '00000000-0000-4000-8000-000000000001' });
    const discussion = await client.v1.resources({ resource: '00000000-0000-4000-8000-000000000001' }).discussion.get({ query: { realm:
      'https://rezics.com/id/00000000-0000-4000-8000-000000000002', limit: 1 } });
    const body: string | undefined = discussion.data?.items[0]?.body;
    const history = await work.history.get({ query: { kind: 'publication-decision', limit: 1 } });
    const next: string | null | undefined = history.data?.nextCursor;
    return { body, next };
  };
  expect(typedReads).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/work-activity' },
  account: {} as never, access: {} as never });
  const paths = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(paths.filter(path => path === '/v1/works/:id/history')).toHaveLength(1);
  expect(paths).toContain('/v1/resources/:resource/discussion');
  expect(paths).not.toContain('/v1/works/:id/discussion');
  expect(WORK_ACTIVITY_COST.pageSize).toBe(20);
  const invalid = await app.handle(new Request('http://main.test/v1/works/00000000-0000-4000-8000-000000000001/history?kind=secret'));
  expect(invalid.status).toBe(400);
});
