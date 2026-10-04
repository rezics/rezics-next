import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtureCorpus } from '../../../scripts/fixture/build.ts';
import {
  fixtureCorpus,
  publicUnitAt,
  sha256,
  type Corpus,
} from '../../../scripts/fixture/corpus.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { graphOwner, verifyGraphCorpus } from '../../../scripts/fixture/owners/graph.ts';
import type { FixtureOwner } from '../../../scripts/fixture/owners/types.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import {
  rankedBilingualQuads,
  RANKED_BILINGUAL_MAINS,
} from '../support/ranked-bilingual-fixture.ts';

// The shared medium backup has only 10,000 units and an intentionally minimal
// legacy visibility shape. This independent backup crosses the former bound
// and carries the exact selected-publication witnesses used by catalogue GET.
export const rankedCorpus = {
  ...fixtureCorpus('medium', 'g556-ranked-v1', 22_004),
  publicUnits: 22_002,
};
function* visibilityQuads(corpus: Corpus) {
  const quad = (subject: string, predicate: string, object: string) =>
    `<${subject}> <${predicate}> <${object}> <${GRAPHS.revisions}> .\n`;
  for (let n = 0; n < corpus.publicUnits; n++) {
    const unit = publicUnitAt(corpus, n);
    yield quad(unit.selection, RV + 'work', unit.work.work);
    yield quad(unit.selection, RV + 'publicationDecision', unit.decision);
    yield quad(unit.selection, RV + 'selectedDraft', unit.draft);
    yield quad(unit.selection, RV + 'context', unit.work.mainVersion);
    yield quad(unit.selection, RV + 'selectionBasis', RV + 'MainMaintainer');
    yield quad(unit.selection, RV + 'selectionMode', RV + 'Fixed');
    yield `<${unit.selection}> <${RV}language> ${JSON.stringify(unit.work.language)} <${GRAPHS.revisions}> .\n`;
    yield quad(unit.decision, RV + 'component', unit.contribution);
    yield quad(unit.decision, RV + 'work', unit.work.work);
    yield quad(unit.decision, RV + 'disclosure', RV + 'Public');
    yield quad(
      unit.draft,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      RV + 'RevisionAnchor',
    );
    yield quad(unit.draft, RV + 'component', unit.contribution);
    yield `<${unit.unit}> <${RV}publicTitle> ${JSON.stringify(unit.work.title)}@en <urn:rezics:search:public> .\n`;
  }
}
const rankedGraphOwner: FixtureOwner = {
  ...graphOwner,
  generator: 'g556-ranked-selected-publication-bilingual-v4',
  compatibilityInputs(root) {
    return {
      ...graphOwner.compatibilityInputs(root),
      'g556-ranked-fixture': sha256(
        readFileSync(join(root, 'tests/qa/integration/g-556-ranked-fixture.ts')),
      ),
      'g556-ranked-bilingual': sha256(
        readFileSync(join(root, 'tests/qa/support/ranked-bilingual-fixture.ts')),
      ),
    };
  },
  summarize(corpus) {
    const base = graphOwner.summarize(corpus);
    const bilingual = rankedBilingualQuads(corpus);
    return {
      digest: sha256(
        base.digest +
          [...visibilityQuads(corpus)].join('') +
          bilingual.map((row) => row.quad).join(''),
      ),
      counts: {
        ...base.counts,
        'graph:current':
          base.counts['graph:current']! + bilingual.filter((row) => row.graph === 'current').length,
        'graph:public':
          base.counts['graph:public']! +
          corpus.publicUnits +
          bilingual.filter((row) => row.graph === 'public').length,
        'graph:revisions':
          base.counts['graph:revisions']! +
          12 * corpus.publicUnits +
          bilingual.filter((row) => row.graph === 'revisions').length,
      },
    };
  },
  load(corpus, target) {
    return graphOwner.load(corpus, {
      ...target,
      fusekiOffline(script, input) {
        if (!input) return target.fusekiOffline(script);
        async function* extended() {
          yield* input!;
          let chunk = '';
          for (const quad of visibilityQuads(corpus)) {
            chunk += quad;
            if (chunk.length >= 1_048_576) {
              yield chunk;
              chunk = '';
            }
          }
          for (const row of rankedBilingualQuads(corpus)) chunk += row.quad;
          if (chunk) yield chunk;
        }
        return target.fusekiOffline(script, extended());
      },
    });
  },
  verify: (corpus, target) =>
    verifyGraphCorpus(corpus, target, corpus.publicUnits + RANKED_BILINGUAL_MAINS),
};
export const rankedFixtureOwners = fixtureOwners.map((owner) =>
  owner.name === 'graph' ? rankedGraphOwner : owner,
);
export const buildRankedFixture = () => buildFixtureCorpus(rankedCorpus, rankedFixtureOwners);
