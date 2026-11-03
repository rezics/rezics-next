import { expect, test } from 'bun:test';
import { creatorSaleDestinations } from '../src/checkout/creator-sale-destinations';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
import { subjectHref } from '../src/subject/subject-href';

test('ordinary localized offer and Subject readers receive only validated destination identities', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const result = creatorSaleDestinations(creatorSaleFixture, locale);
    expect(result.offer).toBe(`/${locale}/offers/${creatorSaleFixture.offerId}`);
    expect(result.work).toBe(subjectHref({ id: creatorSaleFixture.targetSubjectId, label: '' }, locale).href);
    for (const href of Object.values(result)) {
      expect(href).not.toContain(creatorSaleFixture.orderId);
      expect(href).not.toContain('?');
      expect(href).not.toContain('#');
      expect(href).not.toContain('/orders/');
    }
    expect(
      creatorSaleDestinations({ ...creatorSaleFixture, title: 'Unrelated title' } as typeof creatorSaleFixture, locale),
    ).toEqual(result);
  }
  for (const invalid of [
    '',
    '../orders/private',
    'https://evil.test',
    'a?returnTo=/orders/private',
    'x'.repeat(4096),
  ]) {
    expect(creatorSaleDestinations({ offerId: invalid, targetSubjectId: invalid }, 'en')).toEqual({
      offer: null,
      work: null,
    });
    expect(creatorSaleDestinations({ ...creatorSaleFixture, offerId: invalid }, 'en').work).not.toBeNull();
  }
});
