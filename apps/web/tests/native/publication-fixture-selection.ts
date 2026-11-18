import type { PublishedSubject, RelationView } from '../../../../specs/web-publication-driver';
import { readWebTestSelectionContext } from '../../scripts/selection';

export type PublicationFixtureSelection = {
  subject?: PublishedSubject;
  view?: RelationView;
  verifiedAgent?: true;
  verifiedReader?: boolean;
};

const subjectsByScenario: Readonly<Record<string, PublishedSubject>> = {
  'Book publishes author word count light-novel form and harem tag': 'book',
  'Recipe publishes instructions diet and PT25M cook time': 'recipe',
  'game metadata agrees with the rendered work': 'game',
  'release metadata preserves release identity and facts': 'release',
  'person metadata agrees with the rendered person': 'person',
  'organization metadata agrees with the rendered organization': 'organization',
  'automated account metadata agrees with the rendered agent': 'automated',
  'stale slug redirects to the canonical localized slug': 'book',
  'configured alternate public origin is canonical': 'book',
  'credit character credited name position and spoiler retain their meaning': 'game',
  'competing native evidence stays separate from public facts and private history shells': 'book',
};

export const traversalSources = {
  editions: 'book',
  contents: 'book',
  cast: 'cast-work',
  crew: 'crew-work',
  inverse: 'person',
  relations: 'relations-work',
} as const satisfies Record<RelationView, string>;

export function publicationFixtureSelection(): PublicationFixtureSelection | undefined {
  const selection = readWebTestSelectionContext();
  if (
    selection?.selectedFiles.length !== 1 ||
    selection.selectedFiles[0] !== 'tests/native/web-publication-outcomes.host.test.ts'
  )
    return;

  const patterns: string[] = [];
  const args = selection.normalizedArgv;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') break;
    const option = /^(?:-t|--test-name-pattern)(?:=(.*))?$/su.exec(arg);
    if (option) patterns.push(option[1] ?? args[++index] ?? '');
  }
  // A literal scenario suffix can narrow setup. General filters and the full
  // suite retain the full inventory, including the exact sitemap population.
  const pattern = patterns.length === 1 ? patterns[0] : undefined;
  if (!pattern?.endsWith('$')) return;
  const name = pattern
    .slice(0, -1)
    .replace(/^\^?(?:(?:published-vertical-metadata|subject-traversal)(?: >)? )?/u, '')
    .replace(/^(?:published-vertical-metadata|subject-traversal): /u, '');
  const subject = Object.hasOwn(subjectsByScenario, name) ? subjectsByScenario[name] : undefined;
  if (subject) return { subject };
  if (name === 'verified agent subject redirects to its handle page') return { verifiedAgent: true };

  const traversal =
    /^(anonymous|editor|verified-agent) reaches (editions|contents|cast|crew|inverse|relations) once in native order across full pages$/u.exec(
      name,
    );
  if (!traversal) return;
  const view = traversal[2] as RelationView;
  const source = traversalSources[view];
  return {
    view,
    ...(source === 'book' || source === 'person' ? { subject: source } : {}),
    verifiedReader: traversal[1] === 'verified-agent',
  };
}
