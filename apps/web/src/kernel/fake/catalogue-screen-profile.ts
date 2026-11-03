import type { Release } from '@rezics/definitions';
import { catalogueCreateFixture, type CreateScenario } from './catalogue-create';
import { subjectFactsFixture } from './subject-facts';
import { relationFixture } from './catalogue-relations';
import type { ScreenTransport } from '../../features/catalogue/screen-profile-view';
import type { ScreenRead } from '../../features/catalogue/screen-profile';
import definitions from '../recorded/definitions-release.json';

export type ScreenScenario = CreateScenario | 'stale' | 'partial';
/** Compose existing request fixtures; no alternate mutation, decision or selection implementation. */
export function screenProfileFixture(
  scenario: ScreenScenario = 'ready',
  locale = 'en',
  correction = false,
  type = 'schema:Movie',
) {
  const creation = catalogueCreateFixture(scenario === 'stale' || scenario === 'partial' ? 'ready' : scenario, locale);
  const facts = subjectFactsFixture(
    scenario === 'uncertain'
      ? 'lost-response'
      : ['denied', 'invalid', 'stale', 'unavailable', 'partial'].includes(scenario)
        ? (scenario as 'denied' | 'invalid' | 'stale' | 'unavailable' | 'partial')
        : 'ready',
    locale,
  );
  const relations = relationFixture('ready', locale);
  for (const fixture of [facts.date, facts.language, relations]) {
    Object.assign(fixture.publicRead.subject, {
      type,
      labels: { en: 'The observatory' },
      descriptions: {},
      aliases: {},
      sourceRecords: [],
    });
    fixture.publicRead.summary = null;
  }
  const release = structuredClone(definitions.release) as Release;
  const load = async (): Promise<ScreenRead> => {
    if (scenario === 'loading') return new Promise(() => {});
    if (scenario === 'definitions-unavailable') return { ok: false, reason: 'unavailable' };
    if (scenario === 'concealed') return { ok: false, reason: 'concealed' };
    if (scenario === 'empty') return { ok: true, release: { ...release, types: {} }, public: null, series: null };
    const current = await facts.transport.read();
    if (!current.ok) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, public: correction ? current.public : null, series: null };
  };
  const transport: ScreenTransport = {
    load,
    create: creation.transport.submit,
    read: creation.transport.read,
    facts: facts.transport,
    review: facts.review,
    relations: relations.transport,
    createdRelations: () => relations.transport,
  };
  return { transport, creation, facts, relations, id: facts.date.id };
}
