import { bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import type { ProfileReleaseScenario, LibraryProfileVertical } from '../../../../../specs/library-profiles-driver.ts';
import {
  fixture,
  libraryProfile,
  legacyProfile,
  libraryLabels,
  LIBRARY_LOCALES,
  sourcesFor,
  unitData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';

export const profileTypes: Record<LibraryProfileVertical, string> = {
  game: 'ex:Child',
  recipe: 'ex:Recipe',
  record: 'ex:Record',
  book: 'schema:Book',
  'book-edition': 'bf:Instance',
  anime: 'schema:TVSeries',
  people: 'ex:Person',
  concept: 'ex:Concept',
  'inheritance-child': 'ex:Child',
};
/** Compiler inputs only. No hand-built registry, compiled type pointers or accepting pins. */
export function profileSources(scenario: ProfileReleaseScenario) {
  const game = libraryProfile('fixture.game');
  game.progress = legacyProfile().progress;
  game.copies.kinds[0].statuses = ['ordered', 'owned', 'lent', 'disposed'].map((id) => ({ id }));
  if (scenario === 'profile-v2-changed-ids') game.entryStateSet.states[1].id = 'reading';
  if (scenario === 'profile-v3-removed-ids')
    game.entryStateSet.states = game.entryStateSet.states.filter((s: { id: string }) => s.id !== 'planned');
  if (scenario === 'profile-import-declaration-only')
    game.importSources = [{ id: 'fixture-import', mappingVersion: 'v1', recordKinds: ['observation'] }];
  const recipe = libraryProfile('fixture.recipe', 'minute');
  const record = libraryProfile('fixture.record', 'minute');
  record.progress = {
    allowed: [
      { mode: 'completed_units', units: [unitData('track', 'completed_units')] },
      ...legacyProfile().progress.allowed,
    ],
  };
  const child =
    scenario === 'profile-inheritance-nearest'
      ? libraryProfile('fixture.nearest')
      : scenario === 'profile-inheritance-conflict'
        ? libraryProfile('fixture.game', 'episode')
        : undefined;
  const input = fixture(game, child);
  const schema = JSON.parse(input.schemas['fixture.yaml']!);

  schema.version = scenario;
  schema.classes.Recipe = { class_uri: 'ex:Recipe', annotations: { library: recipe } };
  schema.classes.Record = { class_uri: 'ex:Record', annotations: { library: record } };
  schema.classes.Concept = { class_uri: 'ex:Concept' };
  const absentProfiles = ['fixture.root', game.id, recipe.id, record.id];
  if (scenario === 'profile-absent') {
    for (const name of ['Root', 'Parent', 'Recipe', 'Record']) delete schema.classes[name].annotations.library;
  }
  for (const locale of LIBRARY_LOCALES) {
    const labels = JSON.parse(input.presentation[`fixture/${locale}`]!);
    Object.assign(labels.types, { 'ex:Recipe': 'recipe', 'ex:Record': 'record', 'ex:Concept': 'concept' });
    Object.assign(labels.libraryProfiles, {
      [recipe.id]: libraryLabels(recipe, locale),
      [record.id]: libraryLabels(record, locale),
    });
    if (scenario === 'profile-absent') {
      for (const id of absentProfiles) delete labels.libraryProfiles[id];
    }
    input.presentation[`fixture/${locale}`] = JSON.stringify(labels);
  }
  // Keep real bundled Book/edition/anime and presentation types available in the SAME compiled release.
  const bundled = bundledSources();
  schema.imports.push('rezics');
  Object.assign(schema.prefixes, { schema: 'http://schema.org/', bf: 'http://id.loc.gov/ontologies/bibframe/' });
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  Object.assign(input.schemas, bundled.schemas);
  Object.assign(input.presentation, bundled.presentation);
  if (scenario.startsWith('profile-manifests-')) {
    const count = scenario === 'profile-manifests-10' ? 10 : 100;
    const manifests = sourcesFor(count, true);
    Object.assign(input.schemas, manifests.schemas);
    Object.assign(input.presentation, manifests.presentation);
  }
  return input;
}
export function compileProfileRelease(scenario: ProfileReleaseScenario = 'profile-v1') {
  return compileCatalogue(profileSources(scenario));
}
