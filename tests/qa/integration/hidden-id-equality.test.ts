import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { registeredHiddenIdReads } from '../../../scripts/qa/hidden-id-equality.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { assertHiddenIdEquality, type HiddenIdCounters } from '../support/hidden-id-equality.ts';
import { isForegroundOperation } from './support/operation-cost.ts';
import { startMediaStack } from './media-support.ts';

const ID = 'https://rezics.com/id/';
const local = (iri: string) => iri.slice(ID.length);

test('a hidden id and an absent id get the same answer on the registered reads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const stack = await startMediaStack('hidden-id-equality');
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = prototype.query;
  let statements = 0;
  let countSql = true;
  let bytes = 0;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    if (countSql && isForegroundOperation()) statements++;
    return originalQuery.apply(this, args);
  };
  try {
    const owner = await stack.member('hidden-owner');
    const outsider = await stack.member('hidden-outsider');
    const hiddenWork = await stack.privateWork(owner.actor, `Hidden work ${randomUUID()}`);
    const absent = randomUUID();
    const realmInput = { name: `Hidden realm ${randomUUID()}`, actingSubject: owner.actor };
    const realm = await createRealmSpace(stack.env, stack.admission(owner.actor, 'space:create:root', 'space.create',
      spaceCreationDigest(realmInput)), realmInput);
    if (!realm.realm) throw new Error('Realm was not created');
    await owner.grant('semantic:create:root', 'semantic.change');
    const valued = await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: ['https://schema.org/Thing'], properties: [] },
    });
    const valuedText = await valued.text();
    if (valued.status !== 201) throw new Error(`semantic resource ${valued.status}: ${valuedText}`);
    const concept = JSON.parse(valuedText) as { component: string; revision: string;
      sourcePosition: { dataEpoch: string; sequence: string } };
    await owner.grant(`semantic:read:${concept.component}`, 'semantic.read');
    await grantRecordedPlatformUse(stack.accessPool, owner.principalId, ['dataset-dumps']);
    await owner.grant(`export:${concept.revision}`, 'export.create');
    const exported = await owner.send('POST', '/v1/exports', {
      profile: 'export-create-v1', actingSubject: owner.actor, useScope: 'evaluation',
      selection: { kind: 'semantic-revision', resource: concept.component, reference: concept.revision,
        expectedPosition: { dataEpoch: concept.sourcePosition.dataEpoch, sequence: concept.sourcePosition.sequence } },
    });
    const exportedText = await exported.text();
    if (exported.status !== 201 && exported.status !== 200) throw new Error(`export ${exported.status}: ${exportedText}`);
    const manifest = JSON.parse(exportedText) as { manifestId?: string };
    if (!manifest.manifestId) throw new Error(`export ${exported.status}: ${exportedText}`);

    const http = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await stack.call(method, path, { token, body, ...(body ? { key: randomUUID() } : {}) });
      bytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    };
    const readCounters = async (): Promise<HiddenIdCounters> => {
      countSql = false;
      try {
        const media = await stack.contentPool.query<{ n: number }>('SELECT count(*)::int AS n FROM media.transform_job');
        const rate = await stack.accessPool.query<{ n: string }>('SELECT coalesce(sum(count), 0)::int AS n FROM access.rate_limit_v1');
        return {
          graphCalls: stack.fuseki.queries,
          sqlStatements: statements,
          bytes,
          mediaGenerations: media.rows[0]!.n,
          rateLimitCharges: Number(rate.rows[0]!.n),
        };
      } finally { countSql = true; }
    };
    const outsiderQuery = (path: string) => {
      const url = new URL(path, 'http://main.local');
      url.searchParams.set('actingSubject', outsider.actor);
      return `${url.pathname}${url.search}`;
    };
    const workId = local(hiddenWork.work);
    const realmId = local(realm.realm);
    const calls = new Map<string, { hidden: string; absent: string; call: (id: string) => Promise<Response> }>();
    for (const operation of registeredHiddenIdReads) {
      if (operation.startsWith('GET /v1/works/')) {
        const path = operation.slice('GET '.length);
        calls.set(operation, {
          hidden: workId, absent,
          call: (id) => http('GET', path.replace('{id}', id)),
        });
      }
    }
    calls.set('GET /v1/realms/{realm}/members', {
      hidden: realmId, absent,
      call: (id) => http('GET', outsiderQuery(`/v1/realms/${id}/members`), undefined, outsider.token),
    });
    calls.set('GET /v1/realms/{realm}/roles', {
      hidden: realmId, absent,
      call: (id) => http('GET', outsiderQuery(`/v1/realms/${id}/roles`), undefined, outsider.token),
    });
    calls.set('GET /v1/exports/{export}', {
      hidden: manifest.manifestId, absent,
      call: (id) => http('GET', `/v1/exports/${id}`, undefined, outsider.token),
    });
    expect([...calls.keys()].sort()).toEqual([...registeredHiddenIdReads]);
    for (const operation of registeredHiddenIdReads) {
      const spec = calls.get(operation)!;
      await assertHiddenIdEquality({ operation, hiddenId: spec.hidden, absentId: spec.absent,
        call: spec.call, readCounters });
    }
  } finally {
    prototype.query = originalQuery;
    await stack.stop();
  }
}, 180_000);
