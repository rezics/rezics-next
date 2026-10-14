import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GRAPHS, iri, RV } from '../src/modules/work/activate.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';

const directory = resolve('.temp/also-enjoyed-read-cost');
type GraphCall = { query: string; ms: number; returnedRows?: number; failure?: string };
type Answer = { persona: string; status: number; body: string; ms: number;
  hostLoad: string; graph: GraphCall[] };

async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('also-enjoyed returns a correct first owner answer within two seconds after supported writes', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl integration admission');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const evidencePath = join(directory, `first-answers-${runId}.json`);
  const stack = await startMediaStack('also-enjoyed-first-answer', { profileCredits: true });
  const answers: Answer[] = [];
  let calls: GraphCall[] | undefined;
  const originalQuery = stack.fuseki.query.bind(stack.fuseki);
  stack.fuseki.query = async (...args) => {
    const active = calls;
    if (!active || !foregroundCounted()) return originalQuery(...args);
    const call: GraphCall = { query: args[0], ms: 0 }, started = performance.now();
    active.push(call);
    try {
      const result = await originalQuery(...args);
      call.returnedRows = result.results?.bindings.length;
      return result;
    } catch (error) { call.failure = String(error); throw error; }
    finally { call.ms = performance.now() - started; }
  };
  try {
    const owner = await stack.member('owner'), member = await stack.member('member');
    // Existing fixture helpers invoke the supported metadata, contribution,
    // publication and selection writers. Type changes use the real HTTP API.
    const source = await stack.publicWork(owner.actor, ['en'], 'First-answer source recipe');
    const candidate = await stack.publicWork(owner.actor, ['en'], 'First-answer candidate recipe');
    for (const work of [source, candidate]) {
      const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
      await owner.grant(`work:edit:${work.work}`, 'work.edit');
      await json(await owner.send('PUT', `/v1/works/${work.work.slice(-36)}/type`, {
        profile: 'work-type-v2', expectedHead: head,
        types: ['https://schema.org/Recipe'], actingSubject: owner.actor,
      }));
    }
    const revisions = async () => ({
      access: (await stack.accessPool.query(`SELECT revision::text,privacy_revision::text,
        (SELECT count(*)::integer FROM access.also_enjoyed_source_change) AS pending
        FROM access.also_enjoyed_source_fence WHERE id`)).rows,
      content: (await stack.contentPool.query(`SELECT revision::text,privacy_revision::text,
        (SELECT count(*)::integer FROM reader.also_enjoyed_source_change) AS pending
        FROM reader.also_enjoyed_source_fence WHERE id`)).rows,
      served: (await stack.accessPool.query(`SELECT a.generation_id,a.graph_epoch,a.graph_sequence::text,
        a.access_revision::text,a.content_revision::text FROM access.derived_generation_head h
        JOIN access.also_enjoyed_generation a ON a.generation_id=h.active_generation
        WHERE h.family='also-enjoyed'`)).rows,
    });
    const before = await revisions();
    // Each persona gets one request. No generation warming or helper retry
    // may turn an initial refusal into reported first-answer availability.
    for (const persona of ['owner', 'member', 'stranger']) {
      const person = persona === 'owner' ? owner : member;
      const url = new URL(`http://main.local/v1/works/${source.work.slice(-36)}/also-enjoyed?limit=12&language=en`);
      const headers = new Headers();
      if (persona !== 'stranger') {
        url.searchParams.set('actingSubject', person.actor);
        headers.set('authorization', `Bearer ${person.token}`);
      }
      const hostLoad = readFileSync('/proc/loadavg', 'utf8').trim();
      const graph: GraphCall[] = [];
      calls = graph;
      const started = performance.now();
      const response = await stack.main.handle(new Request(url, { headers }));
      const body = await response.text();
      calls = undefined;
      answers.push({ persona, status: response.status, body, ms: performance.now() - started, hostLoad, graph });
      writeFileSync(evidencePath, JSON.stringify({ runId, population: { works: [source, candidate],
        people: [owner.actor, member.actor], supportedWrites: ['metadata', 'contribution', 'publication', 'selection', 'type'] },
      revisions: { before, after: await revisions() }, answers,
      graphScanEvidence: 'Returned rows are measured; plain SPARQL internal tuple visits remain unknown.' }, null, 2));
    }
    // Retain every first response before any assertion stops the test.
    for (const answer of answers) {
      expect(answer.status, `${answer.persona}: ${answer.body}`).toBe(200);
      const page = JSON.parse(answer.body) as { items: { id: string; basis: string }[] };
      expect(page.items).toContainEqual(expect.objectContaining({ id: candidate.work, basis: 'similar' }));
      expect(page.items.some(item => item.id === source.work)).toBe(false);
      expect(answer.ms, `${answer.persona} first-answer wall time`).toBeLessThan(2_000);
    }
  } finally {
    calls = undefined;
    stack.fuseki.query = originalQuery;
    await stack.stop();
    console.log(`Also-enjoyed first-answer evidence: ${evidencePath}`);
  }
}, 120_000);
