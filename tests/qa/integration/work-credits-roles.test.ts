import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { adoptAuthorCredit } from '../../../services/main/src/modules/work/author-credit.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WORK_CREDIT_ROLES } from '../../../services/main/src/modules/work/read-contract.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('a Work reads author, director, artist and animation studio through the credit template', async () => {
  const stack = await startMediaStack('work-credits-roles', { profileCredits: true });
  try {
    const member = await stack.member('credit-roles');
    const created = await stack.publicWork(member.actor, ['en'], 'Four credit roles');
    await member.grant(`work:edit:${created.work}`, 'work.edit');
    const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    const author = native();
    const adopted = await adoptAuthorCredit(stack.env, {
      verify: async () => member.principal,
    }, stack.access, new Request('http://main.local/credits', {
      headers: { authorization: `Bearer ${member.token}` },
    }), {
      work: created.work, credit: author, revision: native(), expectedHead: head,
      sourceKey: '/authors/OL1A', sourceRoleKey: null, nativeOrdinal: 0, actingSubject: member.actor,
    }, native(), randomUUID());
    expect(adopted.receipt.credit).toBe(author);
    const posted: Record<string, string> = { author };
    for (const role of ['director', 'artist', 'animation-studio', 'translator'] as const) {
      const credit = native();
      const response = await member.send('POST', `/v1/works/${created.work.slice(-36)}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit, agent: member.actor, role,
        expectedWorkHead: head, actingSubject: member.actor,
      });
      const text = await response.text();
      expect(response.status, text).toBe(201);
      expect(JSON.parse(text).role).toBe(role);
      posted[role] = credit;
    }
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const read = async (role?: string) => {
      const response = await stack.call('POST', '/v1/query', { body: {
        profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
        parameters: { roots: [created.work], ...(role ? { role } : {}) }, limit: 20,
      } });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) as {
        code?: string;
        result?: { items: Array<Record<string, unknown>> };
      } : {} };
    };
    const page = await read();
    expect(page.status, page.text).toBe(200);
    const items = page.body.result!.items;
    expect(items.map(item => item.role)).toEqual([...WORK_CREDIT_ROLES]);
    expect(items.map(item => item.id)).toEqual(WORK_CREDIT_ROLES.map(role => posted[role]));
    expect(items[0]).toMatchObject({
      role: 'author', participantKind: 'external-reference', provider: 'open-library',
      key: '/authors/OL1A', ordinal: 0, agent: null, displayName: null, handle: null,
    });
    expect(items[0]!.confirmation).toBeUndefined();
    for (const item of items.slice(1)) {
      expect(item).toMatchObject({
        participantKind: 'agent', provider: null, key: null, ordinal: null,
        agent: member.actor, displayName: null, handle: null,
      });
    }
    const listed = await stack.call('GET', `/v1/works/${created.work.slice(-36)}/credits`);
    const listedText = await listed.text();
    expect(listed.status, listedText).toBe(200);
    expect((JSON.parse(listedText) as { items: Array<{ id: string }> }).items.map(item => item.id))
      .toEqual(items.map(item => item.id));
    const director = await read('director');
    expect(director.status, director.text).toBe(200);
    expect(director.body.result!.items.map(item => item.id)).toEqual([posted.director]);
    const refused = await read('cast');
    expect(refused.status).toBe(400);
  } finally { await stack.stop(); }
}, 180_000);
