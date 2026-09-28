import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { idList } from '../src/modules/management-reads/context.ts';
import { MODERATION_CONTEXT_COST } from '../src/modules/management-reads/read-contract.ts';
import { WorkReadInvalid } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('G-395 moderation context is one typed read, never taken for a case ID', async () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typed = async () => {
    const realm = client.v1.realms({ realm: '00000000-0000-4000-8000-000000000001' });
    const read = await realm.moderation.context.get({ query: { actingSubject: id(2), agents: id(3), works: id(4) } });
    const reports: number | undefined = read.data?.people[0]?.reports?.upheld;
    const loaders: string[] | undefined = read.data?.works[0]?.mod?.loaders;
    const filtered = await realm.moderation.get({ query: { actingSubject: id(2), reason: 'spoiler.in_title' } });
    const target: string | undefined = (await realm.audit.get({ query: { actingSubject: id(2) } })).data?.items[0]
      ?.target?.resource;
    return { reports, loaders, filtered, target };
  };
  expect(typed).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph, lineage: { dataEpoch: 'one', routingEpoch: 'one' },
    objectDirectory: '.temp/management-context' }, access: {} as never,
  account: { verify: async () => { throw new AccountAssertionDenied('no bearer'); } } });
  const response = await app.handle(new Request(
    `http://main.test/v1/realms/00000000-0000-4000-8000-000000000001/moderation/context?actingSubject=${encodeURIComponent(id(2))}`));
  // The context route answers (401 without consent); `:caseId` would refuse the word as a UUID (400).
  expect(response.status).toBe(401);
});

test('G-395 context lists name at most twenty distinct native IDs', () => {
  expect(idList(undefined, 20)).toEqual([]);
  expect(idList('', 20)).toEqual([]);
  expect(idList(`${id(1)},${id(2)}`, 20)).toEqual([id(1), id(2)]);
  expect(() => idList(`${id(1)},${id(1)}`, 20)).toThrow(WorkReadInvalid);
  expect(() => idList('urn:rezics:not-native', 20)).toThrow(WorkReadInvalid);
  expect(() => idList(Array.from({ length: MODERATION_CONTEXT_COST.agents + 1 }, (_, n) => id(n)).join(','),
    MODERATION_CONTEXT_COST.agents)).toThrow(WorkReadInvalid);
});
