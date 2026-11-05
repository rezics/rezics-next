import { expect, test } from 'bun:test';
import { workReleaseComparisonExample } from '../src/features/catalogue/game-reader/comparison-example';
import { gameDatePresentation } from '../src/features/catalogue/game-reader/date';

test('comparison keeps exact membership evidence, current work advice and release-specific facts', async () => {
  const fixture = workReleaseComparisonExample('partial');
  const page = await fixture.read();
  if (!page.ok || page.workReleaseCards?.state !== 'available') throw new Error('Expected disclosed comparison');
  const card = page.workReleaseCards.cards[0]!;
  const membership = fixture.first.links[0]!.assertion!;
  expect(card.membership).toEqual(membership);
  expect(card.membership.id).toBe(fixture.first.links[0]!.statement);
  expect(card.membership.value.content).toBe(fixture.address.id);
  expect(card.fields['schema:gamePlatform'].state).toBe('available');
  expect(card.fields['schema:inLanguage']).toMatchObject({
    state: 'available',
    statements: [{ value: { content: 'ja' } }],
  });
  expect(
    gameDatePresentation(
      card.fields['schema:datePublished'].state === 'available'
        ? card.fields['schema:datePublished'].statements[0]!
        : membership,
      page.digest,
      'en',
    ).kind,
  ).toBe('partial');
  expect(card.fields['schema:publisher'].state).toBe('available');
  expect(card.fields['schema:producer'].state).toBe('available');
  expect(card.fields['wdt:P178'].state).toBe('available');
  expect(card.fields['wdt:P2899'].state).toBe('available');
  expect(card.fields['wdt:P5804'].state).toBe('unsupported');
  expect(card.fields['rezics:releaseStatus'].state).toBe('missing');
  expect(page.public.viewerActions?.state).toBe('available');
  expect(fixture.calls[0]).toContain('includeViewerActions=true');
  if (page.public.viewerActions?.state === 'available')
    expect(page.public.viewerActions.actions.some(({ action }) => action.includes('publish'))).toBe(false);
});

test('TBA, withheld age and sparse comparisons retain separate meanings', async () => {
  const tba = workReleaseComparisonExample('tba');
  const tbaPage = await tba.read();
  if (!tbaPage.ok || tbaPage.workReleaseCards?.state !== 'available') throw new Error('Expected TBA comparison');
  const tbaDate = tbaPage.workReleaseCards.cards[0]!.fields['schema:datePublished'];
  if (tbaDate.state !== 'available') throw new Error('Expected disclosed date statement');
  expect(gameDatePresentation(tbaDate.statements[0]!, tbaPage.digest, 'en').kind).toBe('tba');

  const withheld = workReleaseComparisonExample('withheld');
  const withheldPage = await withheld.read();
  if (!withheldPage.ok || withheldPage.workReleaseCards?.state !== 'available')
    throw new Error('Expected withheld card');
  expect(withheldPage.workReleaseCards.cards[0]!.fields['wdt:P2899']).toEqual({ state: 'withheld' });
  expect(withheldPage.workReleaseCards.cards[0]!.fields['schema:contentRating']).toEqual({ state: 'unsupported' });

  const sparse = workReleaseComparisonExample('sparse');
  const sparsePage = await sparse.read();
  expect(sparsePage.ok && sparsePage.editions).toEqual([]);
  expect(sparsePage.ok && sparsePage.workReleaseCards).toEqual({ state: 'available', cards: [] });
});

test('an unavailable comparison does not remove the disclosed release page', async () => {
  const fixture = workReleaseComparisonExample('partial');
  fixture.respond({ ...fixture.first, workReleaseCards: { state: 'unavailable' } });
  const page = await fixture.read();
  expect(page.ok && page.editions).toHaveLength(1);
  expect(page.ok && page.workReleaseCards).toEqual({ state: 'unavailable' });
});
