import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';
import { seedTypes, type TypeRegistry } from '../../../apps/web/features/catalogue/types.ts';
import { discoveryQuery, parseDiscoverState, shelvesFor } from '../../../apps/web/features/discover/state.ts';
import { catalogueYearScope } from '../../../apps/web/features/zones/catalogue-browse.tsx';
import { parseBrowseState } from '../../../apps/web/features/zones/browse-state.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { seedFirstPublicationDate } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test('served discovery types and scoped publication years admit an Anime through composed Main', async () => {
  const stack = await startMediaStack('discovery-year-readers');
  try {
    const editor = await stack.member('year-cataloguer');
    const type = 'https://schema.org/TVSeries';
    seedTypes(await json<TypeRegistry>(await stack.call('GET', '/v1/types')));
    const state = parseDiscoverState({ type });
    expect(state?.type).toBe(type);
    expect(discoveryQuery(state!, shelvesFor(state!)[0]!, { limit: 20, language: 'en' }).type).toBe(type);
    for (const [scope, action] of [
      ['semantic:create:root', 'semantic.change'],
      [`statement:speak:${editor.actor}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide'],
    ] as const) await editor.grant(scope, action);
    await ensureGlobalClassificationContext(stack.env);
    const property = await seedFirstPublicationDate({
      post: async <T>(path: string, body: object, key: string) => json<T>(await editor.send('POST', path, body, key)),
      authorizeDefinition: async receipt => { await editor.grant(`semantic:read:${receipt.component}`, 'semantic.read'); },
    }, editor.actor);
    const created = await stack.catalogueWork(editor.actor, 'Orbital Anime', [type]);
    const text = await stack.contribution(created.work, editor.actor, 'en', 'Opening text');
    const selected = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: text.contribution, publicationDecision: text.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    expect((await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selected)), selected)).outcome).toBe('succeeded');
    const input = { name: 'Anime year directory', actingSubject: editor.actor };
    const space = await createRealmSpace(stack.env,
      stack.admission(editor.actor, 'space:create:root', 'space.create', spaceCreationDigest(input)), input);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('Realm creation failed');
    const realm = space.realm;
    const adoption = { context: { kind: 'realm-local' as const, id: realm }, work: created.work,
      mainVersion: created.mainVersion, contribution: text.contribution, publicationDecision: text.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const, actingSubject: editor.actor };
    expect((await selectRealmLocal(stack.env, stack.admission(editor.actor,
      `publication:adopt:${realm}`, 'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome).toBe('succeeded');
    const statement = await json<{ statement: string }>(await editor.send('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: created.work,
      predicate: property.component, relationDefinition: property.revision,
      value: { kind: 'literal', lexical: '1995-01-01', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: editor.actor,
    }));
    await json(await editor.send('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: editor.actor,
    }));
    const read = async (parameters: object) => json<{ result: { items: { id: string; year: number }[] } }>(
      await stack.call('POST', '/v1/query', { body: { profile: 'template-query-v1',
        query: 'https://rezics.com/query/work-publication-years', revision: 1, parameters, limit: 20 } }));
    const scope = catalogueYearScope(realm, parseBrowseState({ type: 'schema:TVSeries', q: 'Orbital' }));
    expect((await read(scope)).result.items).toMatchObject([{ id: created.work, year: 1995 }]);
    expect((await read({ ...scope, text: 'unmatched title' })).result.items).toEqual([]);
    expect((await read(catalogueYearScope(realm, parseBrowseState({ type: 'schema:Book' })))).result.items).toEqual([]);
    const summaries = await json<{ summaries: { reference: string; status: string }[] }>(await stack.call('POST', '/v1/resources/summaries',
      { body: { profile: 'resource-summary-batch-v1', resources: [created.work], context: realm } }));
    expect(summaries.summaries).toMatchObject([{ reference: created.work, status: 'available' }]);
  } finally { await stack.stop(); }
});
