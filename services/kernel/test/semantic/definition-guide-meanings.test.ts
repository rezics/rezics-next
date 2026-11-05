import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { pickText } from '@rezics/composition';
import { releaseDigest, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import historicalBundle from '../../../../packages/definitions/test/fixtures/bundled-historical-construction.json';
import recordedActive from '../../../../apps/web/src/kernel/recorded/definitions-active.json';
import recordedRelease from '../../../../apps/web/src/kernel/recorded/definitions-release.json';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSemanticDriver } from './outcome-driver.ts';

test('The actual bundled release supplies useful localized Type and field meanings to the default guide for every supported catalogue Type and property with cooking time unit guidance and no invented meanings from fixtures', async () => {
  // The ordinary driver mounts createKernel and performs the same bundled setup as
  // server startup. No injected catalogue or descriptor supplies these meanings.
  const driver = await createSemanticDriver();
  const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
  try {
    const active = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    expect(active.status).toBe(200);
    expect(active.body).toEqual({ digest: bundledDigest, head: 1 });
    const response = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${active.body.digest}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ digest: bundledDigest, release: bundledRelease });
    expect(response.headers.get('etag')).toBe(`"${bundledDigest}"`);
    expect(await compileCatalogue(bundledSources())).toEqual(bundledRelease);
    expect({ ...active.body, status: active.status }).toEqual(recordedActive);
    expect({ ...response.body, status: response.status }).toEqual(recordedRelease);

    // The guide reads the active digest, then the immutable release, and selects
    // localized text with pickText. Keep that read shape without importing UI state.
    const release = response.body.release as Release;
    const guide = { digest: active.body.digest, types: release.types, properties: release.properties };
    const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
    for (const [kind, terms] of [
      ['Type', guide.types],
      ['field', guide.properties],
    ] as const) {
      expect(Object.keys(terms).length).toBeGreaterThan(0);
      for (const [curie, term] of Object.entries(terms)) {
        for (const locale of locales) {
          const meaning = pickText(term.descriptions ?? {}, locale);
          const context = `${kind} ${curie} in ${locale}`;
          expect(meaning.lang, context).toBe(locale);
          expect(meaning.text.trim().length, context).toBeGreaterThan(10);
          expect(meaning.text, context).not.toBe(term.labels[locale]);
          if (locale !== 'en') expect(meaning.text, context).not.toBe(term.descriptions?.en);
        }
      }
    }
    for (const type of Object.values(guide.types))
      for (const property of type.properties) expect(guide.properties[property]).toBeDefined();

    const cookTime = guide.properties['schema:cookTime']!;
    expect(cookTime.datatype).toBe('quantity');
    expect(cookTime.units).toEqual(['http://www.wikidata.org/entity/Q7727']);
    const minuteWords = {
      en: 'minutes',
      de: 'Minuten',
      es: 'minutos',
      fr: 'minutes',
      ja: '分',
      ko: '분',
      'zh-Hans': '分',
      'zh-Hant': '分',
    };
    for (const [locale, minute] of Object.entries(minuteWords)) {
      const meaning = pickText(cookTime.descriptions!, locale);
      expect(meaning.text).toContain(minute);
      expect(meaning.text).toContain('wd:Q7727');
      expect(meaning.text).toContain('25');
    }
    expect(cookTime.descriptions!.en).toContain('Duration of actual cooking');
    expect(cookTime.descriptions!.en).toContain('not a time of day');
    expect(guide.properties['schema:recipeIngredient']!.descriptions!.en).toContain('language-tagged text');
    expect(guide.properties['schema:recipeYield']!.descriptions!.en).toContain('Number of servings');
    expect(guide.properties['schema:abstract']!.descriptions!.en).toContain('summary document');
    expect(guide.properties['wdt:P3831']!.descriptions!.en).toContain('Concept');

    // Publication and activation still use native grants. A genuine old bundle
    // supplies only the historical-pin control, never the current guide's text.
    await driver.grant('steward', ['gate:definition_publication'], driver.globalContext);
    const old = historicalBundle as Release;
    const oldDigest = releaseDigest(old);
    const published = await driver.request('steward', 'POST', '/v1/definitions/releases', { release: old }, key());
    expect(published.status).toBe(201);
    expect(published.body).toEqual({ digest: oldDigest });
    const activated = await driver.request(
      'steward',
      'POST',
      `/v1/definitions/releases/${oldDigest}:activate`,
      { expected_head: 1 },
      key(),
    );
    expect(activated.status).toBe(200);
    expect(activated.body).toEqual({ digest: oldDigest, head: 2 });
    expect(await bootstrapRelease(driver.fixtures.pool, bundledRelease)).toBe(oldDigest);
    const preserved = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    expect(preserved.body).toEqual(activated.body);
    const pinnedOld = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${oldDigest}`);
    expect(pinnedOld.body).toEqual({ digest: oldDigest, release: old });
    expect(pinnedOld.headers.get('etag')).toBe(`"${oldDigest}"`);
    const currentPin = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${bundledDigest}`);
    expect(currentPin.body).toEqual(response.body);
  } finally {
    await driver.close();
  }
}, 180_000);
