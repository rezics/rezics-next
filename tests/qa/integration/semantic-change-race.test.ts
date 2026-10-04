import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readSemanticChangeTerminal } from '../../../services/main/src/modules/semantic/change.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

type Change = { component: string; revision: string; receipt: string };
type Work = { work: string; workRevision: string };
const baseType = 'https://example.org/Resource';
const addedType = 'https://example.org/AddedType';
const predicate = 'https://example.org/description';
const properties = [{ predicate, value: { kind: 'string', lexical: 'Winner' } }];

test('semantic change races retain 409 and the winning head across admission, ownership validation, CAS and replay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = resolve('.temp', `semantic-change-race-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  const graph = f.env.fuseki;
  const write = (target: string | undefined, expectedHead: string | null, types: string[],
    assertions = properties, key = randomUUID()) => f.call('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', actingSubject: f.actor, ...(target ? { target } : {}),
    expectedHead, state: { component: 'resource', types, properties: assertions },
  }, key);
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    for (const seam of ['after-admission', 'first-description-predicate', 'existing-predicate',
      'existing-type', 'write-cas'] as const) {
      f.env.fuseki = graph;
      const firstDescription = seam === 'first-description-predicate';
      const initial = firstDescription
        ? await f.json<Work>(await f.call('POST', '/v1/works', await f.authoredBody({
          profile: 'metadata-only-v1', language: 'en', title: 'Semantic attachment race',
          actingSubject: f.actor,
        })), 201)
        : await f.json<Change>(await write(undefined, null, [baseType], []), 201);
      const target = 'work' in initial ? initial.work : initial.component;
      const expectedHead = 'workRevision' in initial ? initial.workRevision : initial.revision;
      await f.grant(`semantic:read:${target}`, 'semantic.read');
      await f.grant(`semantic:edit:${target}`, 'semantic.change');
      const types = firstDescription ? [] : seam === 'existing-type' ? [baseType, addedType] : [baseType];
      const assertions = seam === 'existing-type' ? [] : properties;
      const loserKey = randomUUID();
      let intercepted = false;
      let winner: Change | undefined;
      const commitWinner = async () => {
        intercepted = true;
        // The loser has already crossed the real Access admission boundary.
        const admission = await f.accessPool.query<{ state: string }>(
          'SELECT state FROM access.admission WHERE idempotency_key = $1', [loserKey]);
        expect(admission.rows).toEqual([{ state: 'claimed' }]);
        expect((await graph.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(target)} <${RV}${firstDescription ? 'head' : 'semanticHead'}> ${iri(expectedHead)} } }`)).boolean).toBe(true);
        winner = await f.json<Change>(await write(target, expectedHead, types, assertions), 200);
      };
      f.env.fuseki = new Proxy(graph, {
        get(client, property) {
          if (property === 'query') return async (query: string) => {
            const ownerQuery = query.includes(iri(target)) && (seam === 'existing-type'
              ? query.includes('SELECT ?type WHERE') && query.includes('VALUES ?type')
              : query.includes('SELECT ?predicate WHERE') && query.includes('VALUES ?predicate'));
            const admissionQuery = seam === 'after-admission' && query.includes('a rv:ModelGeneration');
            if (!intercepted && seam !== 'write-cas' && (ownerQuery || admissionQuery)) await commitWinner();
            return client.query(query);
          };
          if (property === 'commandWithReceipt') return async (envelope: Parameters<typeof client.commandWithReceipt>[0]) => {
            if (!intercepted && seam === 'write-cas'
              && envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor')) await commitWinner();
            return client.commandWithReceipt(envelope);
          };
          const value = Reflect.get(client, property, client);
          return typeof value === 'function' ? value.bind(client) : value;
        },
      });
      const loser = await write(target, expectedHead, types, assertions, loserKey);
      expect(intercepted).toBe(true);
      expect(loser.status).toBe(409);
      expect(loser.headers.get('content-type')).toContain('application/problem+json');
      const conflict = await loser.json();
      expect(conflict).toMatchObject({ code: 'stale_head', currentHead: winner!.revision });
      f.env.fuseki = graph;
      const admission = await f.accessPool.query<{ id: string; state: string; graph_outcome: string }>(
        'SELECT id, state, graph_outcome FROM access.admission WHERE idempotency_key = $1', [loserKey]);
      expect(admission.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
      expect(await readSemanticChangeTerminal(f.env, admission.rows[0]!.id)).toMatchObject({
        outcome: 'cancelled', reason: 'stale-head', currentHead: winner!.revision,
      });
      // A later successor must not change the retained basis of this conflict.
      const successor = await f.json<Change>(await write(target, winner!.revision, types, assertions), 200);
      const replay = await write(target, expectedHead, types, assertions, loserKey);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual(conflict);
      expect((await graph.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(target)} <${RV}semanticHead> ${iri(successor.revision)} } }`)).boolean).toBe(true);
    }

    const existing = await f.json<Change>(await write(undefined, null, [baseType], []), 201);
    await f.grant(`semantic:read:${existing.component}`, 'semantic.read');
    await f.grant(`semantic:edit:${existing.component}`, 'semantic.change');
    // Another component already owns these triples at the named semantic head.
    await graph.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(existing.component)} a <${addedType}> ; <${predicate}> "Other owner" . } }`);
    for (const [types, assertions] of [[ [baseType, addedType], [] ], [ [baseType], properties ]] as const) {
      const refused = await write(existing.component, existing.revision, [...types], [...assertions]);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: 'reserved_owner' });
    }
  } finally {
    f.env.fuseki = graph;
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
