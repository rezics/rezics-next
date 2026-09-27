import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { realmGovernanceScope } from '../src/modules/management-reads/read-store.ts';

test('Management reads expose concrete private pages to the web Eden client', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedReads = async () => {
    const realm = client.v1.realms({ realm: '00000000-0000-4000-8000-000000000001' });
    const moderation = await realm.moderation.get({ query: {
      actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
      state: 'open', type: 'content_report', limit: 2 } });
    const audit = await realm.audit.get({ query: {
      actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
      kind: 'content_moderation', limit: 2 } });
    const target: string | undefined = moderation.data?.items[0]?.target.resource;
    const author: string | null | undefined = moderation.data?.items[0]?.authorAgent;
    const actor: string | undefined = audit.data?.items[0]?.actingSubject;
    const next: string | null | undefined = audit.data?.nextCursor;
    return { target, author, actor, next };
  };
  expect(typedReads).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/management-read' },
  account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(gets).toContain('/v1/realms/:realm/moderation');
  expect(gets).toContain('/v1/realms/:realm/audit');
  expect(realmGovernanceScope('https://rezics.com/id/00000000-0000-4000-8000-000000000001'))
    .toBe('governance:realm:https://rezics.com/id/00000000-0000-4000-8000-000000000001');
});
