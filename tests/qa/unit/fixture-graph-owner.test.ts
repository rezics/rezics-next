import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  fixtureCorpus,
  fixtureRealm,
  fixtureUuid,
  publicUnitAt,
} from '../../../scripts/fixture/corpus.ts';
import { graphOwner } from '../../../scripts/fixture/owners/graph.ts';
import { GRAPHS, ID, RV } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionSlotIri } from '../../../services/main/src/modules/work/select-realm.ts';

test('fixture: Realm slot uses the current canonical owner across small and medium populations', () => {
  for (const corpus of [
    fixtureCorpus('small', 'canonical-slot', 3),
    fixtureCorpus('small', 'canonical-slot'),
    fixtureCorpus('medium', 'canonical-slot'),
  ]) {
    const realm = fixtureRealm(corpus);
    const rejected = publicUnitAt(corpus, Math.min(129, corpus.publicUnits - 1));
    expect(realm.rejectionSlot).toBe(realmSelectionSlotIri(realm.realm, rejected.work.mainVersion));
    expect(realm.rejectionSlot).not.toBe(ID + fixtureUuid(corpus.seed, 'public-rejection-slot'));
  }
  expect(graphOwner.generator).toBe('graph-work-public-search-v4');
});

test('fixture: actual streamed graph bytes carry the exact Realm Work link and agree with the owner summary', async () => {
  const corpus = fixtureCorpus('small', 'canonical-slot', 3);
  const realm = fixtureRealm(corpus);
  const rejected = publicUnitAt(corpus, corpus.publicUnits - 1);
  const access = new Pool(),
    content = new Pool();
  let bytes = '';
  try {
    await graphOwner.load(corpus, {
      root: '',
      apps: {},
      pools: { access, content },
      async fusekiOffline(_script, input) {
        if (input) for await (const chunk of input) bytes += chunk;
        return '';
      },
    });
    const lines = bytes.trim().split('\n');
    const slot = lines.filter((line) => line.startsWith(`<${realm.rejectionSlot}> `));
    expect(slot).toHaveLength(5);
    for (const [predicate, object] of [
      ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${RV}RealmPublicationSlot`],
      [`${RV}realm`, realm.realm],
      [`${RV}mainVersion`, rejected.work.mainVersion],
      [`${RV}work`, rejected.work.work],
      [`${RV}selectionHead`, realm.rejectionSelection],
    ])
      expect(slot).toContain(
        `<${realm.rejectionSlot}> <${predicate}> <${object}> <${GRAPHS.current}> .`,
      );
    expect(bytes).not.toContain(ID + fixtureUuid(corpus.seed, 'public-rejection-slot'));
    const counts = graphOwner.summarize(corpus).counts;
    expect(lines.filter((line) => line.endsWith(`<${GRAPHS.current}> .`))).toHaveLength(
      counts['graph:current']!,
    );
    expect(lines.filter((line) => line.endsWith(`<${GRAPHS.revisions}> .`))).toHaveLength(
      counts['graph:revisions']!,
    );
    expect(lines.filter((line) => line.endsWith('<urn:rezics:search:public> .'))).toHaveLength(
      counts['graph:public']! - 2,
    );
  } finally {
    await Promise.all([access.end(), content.end()]);
  }
});
