import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('v1 Concept discovery binds its Sense head in native vocabulary and Realm topic queries', async () => {
  const stack = await startMediaStack('vocabulary-concept-revisions');
  try {
    const editor = await stack.member('vocabulary-editor');
    await grantFixtureAuthority(stack.accessPool, { scope: 'classification:define:global', requireDispatch: true,
      representations: [{ principalId: editor.principalId, actor: editor.actor,
        action: 'classification.proposition.define', lifetime: 'infinity' }],
      grant: { actor: editor.actor, action: 'classification.proposition.define', lifetime: 'infinity' } });
    const label = `Native v1 Concept ${randomUUID()}`;
    const created = await json<{ concept: string; sense: string; definitionRevision: string }>(
      await editor.send('POST', '/v1/classification-propositions', {
        profile: 'classification-proposition-v1', label, actingSubject: editor.actor,
      }), 201);
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.concept)} rv:head ?head } }`)).boolean).toBe(false);
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.sense)} rv:head ${iri(created.definitionRevision)} } }`)).boolean).toBe(true);

    const vocabularyPath = `/v1/classification-vocabulary?q=${encodeURIComponent(label)}&language=en`;
    const topicPath = `/v1/realms?sort=newest&topic=${encodeURIComponent(created.concept)}&language=en`;
    const vocabulary = await json<{ items: { id: string; label: string }[] }>(await stack.call('GET', vocabularyPath));
    expect(vocabulary.items).toEqual([{ id: created.concept, label }]);
    const directory = await json<{ topic: { id: string; label: { value: string } } }>(
      await waitForRealmDirectory(stack.env, () => stack.call('GET', topicPath)));
    expect(directory.topic.id).toBe(created.concept);
    expect(directory.topic.label.value).toBe(label);

    // Execute the counterexample in Jena too: an unbound Sense head must make
    // both resolvers unavailable. The transport never reconstructs a revision.
    const nativeQuery = stack.fuseki.query;
    const brokenPaths: string[] = [];
    stack.fuseki.query = async (query, ...args) => {
      if (query.includes('COALESCE(?conceptHead, ?senseHead) AS ?head')) {
        brokenPaths.push(query.includes('SELECT ?concept') ? 'vocabulary' : 'topic');
        query = query.replace('rv:head ?senseHead', 'rv:head ?unboundSenseHead');
      }
      return nativeQuery.call(stack.fuseki, query, ...args);
    };
    try {
      expect((await stack.call('GET', vocabularyPath)).status).toBe(503);
      expect((await stack.call('GET', topicPath)).status).toBe(503);
      expect(brokenPaths).toEqual(['vocabulary', 'topic']);
    } finally { stack.fuseki.query = nativeQuery; }
  } finally { await stack.stop(); }
}, 120_000);
