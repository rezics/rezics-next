import { expect, test } from 'bun:test';
import { synchronizeAccountAgent } from '../../src/access/account-agent-effect.ts';
import { createKernelCreditSearchSource } from '../../src/composition/runtime-defaults.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import type { SubjectDocument } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { accountErasureFixture } from '../semantic/support/account-erasure-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';

const statement = (property: string, content: string) => [
  { property: { id: property }, value: { type: 'value', content }, rank: 'normal' },
];

test('the ordinary writer removes the erased personal agent and its attribution on initial cleanup and replay', async () => {
  const fixture = await accountErasureFixture();
  const pool = fixture.db.pool;
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `erased-agent-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  try {
    const owner = await fixture.author();
    const agent = accountAgentId(owner.accountId);
    const name = `Personal name ${crypto.randomUUID()}`;
    const title = `Public contribution ${crypto.randomUUID()}`;
    await ensureAccountAgent(pool, { account: owner.accountId, kind: 'person', name });
    const created = await fixture.call(owner, 'POST', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: title },
      statements: {
        'schema:author': statement('schema:author', agent),
        'schema:inLanguage': statement('schema:inLanguage', 'en'),
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const work = created.body.subject.id as string;
    const concept = await fixture.call(owner, 'POST', '/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: 'Independent concept' },
      statements: { 'foaf:focus': statement('foaf:focus', agent) },
    });
    expect(concept.status, JSON.stringify(concept.body)).toBe(201);
    const focus = concept.body.subject.id as string;
    const ids = [agent, work, focus];
    const routeKey = testRouteKey();
    const { source } = createRatedSubjectSource(
      pool,
      routeKey,
      createKernelCreditSearchSource(pool, routeKey),
      composeSearchNativePorts(),
    );
    await createSubjectIndex(search, prefix, 1);
    const writer = createSearchWriterGuard({
      pool,
      search,
      source,
      listing: subjectListingSource(pool),
      index,
      consumer: subjectConsumer(prefix, 1),
    });
    const home = partitionOf(routeOf(agent)!);
    const read = async () =>
      (
        await search.request<{ docs: { found: boolean; _source?: SubjectDocument }[] }>('POST', `/${index}/_mget`, {
          ids,
        })
      ).body.docs;
    const write = async () => {
      for (const id of ids) await writer.write(partitionOf(routeOf(id)!), [id], 0n);
    };
    await write();
    const [personal, contribution, classification] = await read();
    expect(personal?._source?.names).toContain(name);
    expect(contribution?._source?.facts).toContainEqual({ property: 'schema:author', value: agent, qualifiers: [] });
    expect(
      contribution?._source?.credited_names.some((credit) => credit.targetId === agent && credit.name.value === name),
    ).toBe(true);
    expect(classification?._source?.statements).toContain(`foaf:focus=${agent}`);
    const before = await source.count(home);
    await fixture.tombstone(owner);
    expect((await source.count(home)).count).toBe(before.count - 1);
    expect((await read())[0]?.found).toBe(true);
    expect((await fixture.status(owner.accountId))?.participants.search?.outcome).toBe('pending');
    const assertClean = async () => {
      await write();
      const [personal, contribution, classification] = await read();
      expect(personal?.found).toBe(false);
      expect(classification?._source?.names).toContain('Independent concept');
      expect(JSON.stringify(classification?._source)).not.toContain(agent);
      expect(contribution?._source?.names).toContain(title);
      expect(contribution?._source?.statements).toContain('schema:inLanguage=en');
      expect(JSON.stringify(contribution?._source)).not.toContain(agent);
      expect(JSON.stringify(contribution?._source)).not.toContain(name);
    };
    await assertClean();
    await synchronizeAccountAgent(pool, owner.accountId);
    await assertClean();
  } finally {
    try {
      await search.request('DELETE', `/${index}`, undefined, { query: { ignore_unavailable: true } });
    } finally {
      await fixture.close();
    }
  }
}, 120_000);
