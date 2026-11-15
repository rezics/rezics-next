import { expect, test } from 'bun:test';
import { platformRegistry, walkStructuralContent, type CompositionDocument } from '@rezics/composition';
import gameStarter from '../../../packages/definitions/presentation/game/zone.json';
import { videoGameCandidate } from '../src/zones/candidates/game';
import { mangaCandidateConfiguration } from '../src/zones/candidates/manga';
import { RECIPE_HOME_DOCUMENTS } from '../src/zones/candidates/recipe';
import { SERIES_CANDIDATE_DOCUMENTS } from '../src/zones/candidates/series';
import { copyStarterIntro } from '../src/zones/candidates/starter-document';

test('Zone candidate copy stays inside its registered starter layout without mutating the source', () => {
  const original = structuredClone(gameStarter);
  const edited = copyStarterIntro(gameStarter.pages[0]!.document as CompositionDocument, 'Video games');
  edited.intro.props['text'] = 'A separate preview notice';
  const documents = [
    ...Object.values(videoGameCandidate.documents),
    ...mangaCandidateConfiguration.pages.map((page) => page.document),
    ...Object.values(RECIPE_HOME_DOCUMENTS),
    ...Object.values(SERIES_CANDIDATE_DOCUMENTS),
  ];
  for (const document of documents) {
    expect(document.content[0]?.type).toBe('Stack');
    const intro = [...walkStructuralContent(platformRegistry, document.content)].filter(
      (node) => node.type === 'Text' && node.props.id === 'intro',
    );
    expect(intro).toHaveLength(1);
    expect(typeof intro[0]!.props['text']).toBe('string');
  }
  const series = copyStarterIntro(SERIES_CANDIDATE_DOCUMENTS.home, 'Series');
  expect(series.siblings[series.siblings.indexOf(series.intro) + 1]?.props.id).toBe('series-preview-note');
  expect(gameStarter).toEqual(original);
});

test('a malformed candidate starter still reports its missing intro', () => {
  expect(() => copyStarterIntro({ root: { props: {} }, content: [] }, 'Video games')).toThrow(
    'The Video games starter intro is missing.',
  );
});
