import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('qualified catalogue credits retain their exact participants, roles and order, and both credit forms retire idempotently', async () => {
  const stack = await startMediaStack('qualified-credit-lifecycle', { profileCredits: true });
  try {
    const member = await stack.member('catalogue contributor');
    await member.grant('work:create:catalogue-import', 'work.create');
    await grantRecordedPlatformUse(stack.accessPool, member.principalId, ['catalogue-import']);
    const work = native();
    const request = { actingSubject: member.actor, input: { profile: 'work-catalogue-import-v1', work,
      expectedWorkHead: null, title: 'A translated production', language: 'en', evidence: 'https://example.org/retained/staff',
      aliases: [], semanticTypes: [], classifications: [], credits: [
        { participant: { kind: 'external-reference', provider: 'bangumi', namespace: 'person', key: '42' }, role: 'director', ordinal: 7 },
        { participant: { kind: 'external-reference', provider: 'vndb', namespace: 'staff', key: '42' }, role: 'translator', ordinal: 3 },
        { agent: member.actor, role: 'editor' },
      ] } };
    const key = randomUUID();
    const written = await member.send('POST', '/v1/work-imports', request, key);
    expect(written.status, await written.clone().text()).toBe(201);
    const result = await written.json() as { status: string; receipt: { work: string; workRevision: string } };
    expect(result.status).toBe('succeeded');
    expect(result.receipt.work).toBe(work);
    const retry = await member.send('POST', '/v1/work-imports', request, key);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'succeeded', receipt: result.receipt, replayed: true });
    const rows = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
      SELECT ?credit ?revision ?role ?provider ?namespace ?key ?ordinal ?agent WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?credit rv:work ${iri(work)} ; rv:creditRevision ?revision ; schema:roleName ?role .
          OPTIONAL { ?credit rv:externalProvider ?provider ; rv:externalNamespace ?namespace ; rv:externalKey ?key ; schema:position ?ordinal }
          OPTIONAL { ?credit rv:agent ?agent } } }`)).results!.bindings;
    expect(rows).toHaveLength(3);
    expect(rows.map(row => ({ role: row.role!.value, provider: row.provider?.value, namespace: row.namespace?.value,
      key: row.key?.value, ordinal: row.ordinal?.value, agent: row.agent?.value }))).toEqual(expect.arrayContaining([
      { role: 'director', provider: 'bangumi', namespace: 'person', key: '42', ordinal: '7', agent: undefined },
      { role: 'translator', provider: 'vndb', namespace: 'staff', key: '42', ordinal: '3', agent: undefined },
      { role: 'editor', provider: undefined, namespace: undefined, key: undefined, ordinal: undefined, agent: member.actor },
    ]));
    await member.grant(`work:edit:${work}`, 'work.edit');
    for (const row of rows) {
      const retirement = { profile: 'work-author-credit-retirement-v1', revision: row.revision!.value,
        expectedHead: result.receipt.workRevision, actingSubject: member.actor, reason: 'A confirmed correction' };
      const path = `/v1/works/${work.slice(-36)}/author-credits/${row.credit!.value.slice(-36)}/retirements`;
      const retirementKey = randomUUID();
      const retired = await member.send('POST', path, retirement, retirementKey);
      expect(retired.status, await retired.clone().text()).toBe(201);
      const again = await member.send('POST', path, retirement, retirementKey);
      expect(again.status, await again.clone().text()).toBe(200);
      expect(await again.json()).toMatchObject({ replayed: true });
    }
    const invented = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ?credit rv:work ${iri(work)} ; rv:externalProvider ?provider ; rv:agent ?agent } }`);
    expect(invented.boolean).toBe(false);
  } finally { await stack.stop(); }
}, 180_000);
