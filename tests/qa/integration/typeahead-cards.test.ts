import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body);
}

// A typeahead suggestion names what the Work is and who wrote it, as a search
// card does, so the reader can tell two "Pride and Prejudice"s apart and the
// suggestion draws the cover the Work has everywhere else.
test('G-377: typeahead suggestions carry the Work’s types and its public authors', async () => {
  const stack = await startMediaStack('typeahead-cards');
  try {
    const actor = await stack.member('typeahead-author');
    const deps = { environment: stack.env, access: stack.access,
      account: { verify: async () => actor.principal }, profiles: new ProfilesAccess(stack.accessPool), personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json',
        'idempotency-key': randomUUID(), authorization: 'Bearer author' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const agent = await json(await call('/v1/agents', { profile: 'agent-provision-v1',
      displayName: 'Soseki 夏目漱石', kind: 'person' }), 201);
    const work = await stack.publicWork(actor.actor, ['en'], 'Kokoro, a typed suggestion');
    const head = await json(await call(`/v1/works/${work.work.slice(-36)}`));
    await actor.grant(`work:edit:${work.work}`, 'work.edit');
    await json(await call(`/v1/works/${work.work.slice(-36)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
      agent: agent.agent, role: 'author', expectedWorkHead: head.revision, actingSubject: actor.actor,
    }), 201);
    const suggest = async (prefix: string) =>
      (await json(await call(`/v1/search/typeahead?prefix=${encodeURIComponent(prefix)}`))).items;

    const byTitle = await suggest('Kokoro');
    expect(byTitle).toMatchObject([{ work: work.work, matchedField: 'title', types: head.types,
      authors: [{ participantKind: 'agent', agent: agent.agent, displayName: 'Soseki 夏目漱石' }] }]);
    // Matched by the author's name, the suggestion still names the Work's author.
    expect(await suggest('Soseki')).toMatchObject([{ work: work.work, matchedField: 'credit',
      authors: [{ displayName: 'Soseki 夏目漱石' }] }]);

    // An author whose profile turns private is no longer named on the title's suggestion.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure ?old } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure rv:Private } } WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure ?old } }`);
    expect(await suggest('Kokoro')).toMatchObject([{ work: work.work, authors: [] }]);
  } finally { await stack.stop(); }
}, 90_000);
