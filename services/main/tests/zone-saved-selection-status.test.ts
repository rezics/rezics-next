import { expect, test } from 'bun:test';
import { direction } from '../src/modules/display-language/select.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE, type ZoneConfiguration } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { zoneSavedPublicationStatus } from '../src/modules/zone/publication.ts';

const iri = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const zone = iri(1);
const navigationRevision = iri(2);
const selection = { variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000003',
  revisionId: '00000000-0000-4000-8000-000000000004', navigationRevision };
const metadata = { name: 'Harbor', language: 'en', direction: direction('en', 'Harbor') };
const legacy = 'https://rezics.com/definition/legacy-zone-layout';

function configuration(presentation: ZoneConfiguration['presentation']): ZoneConfiguration {
  return { format: ZONE_CONFIG_FORMAT, model: ZONE_PROFILE, zone, space: iri(5), navigation: iri(6),
    state: 'active', disclosure: 'public', budget: { timeMs: 2000, rows: 1000 }, queryBlocks: [],
    ...(presentation !== undefined ? { presentation } : {}) };
}

function status(savedPresentation: ZoneConfiguration['presentation'], publishedPresentation: ZoneConfiguration['presentation']) {
  // The pure comparison consumes these selection fields; no owner reads run.
  const saved = { zone, ...metadata, configuration: configuration(savedPresentation) } as
    Parameters<typeof zoneSavedPublicationStatus>[0];
  const published = { ...metadata, disclosure: 'public', configuration: configuration(publishedPresentation),
    bundle: { routesRevision: navigationRevision, navigationRevision,
      pages: [{ page: zone, variantId: selection.variantId, revisionId: selection.revisionId }] } } as
    Parameters<typeof zoneSavedPublicationStatus>[1];
  return zoneSavedPublicationStatus(saved, published, selection);
}

test('retained legacy presentation references use the same effective defaults as omitted or explicit defaults', () => {
  expect(status(legacy, DEFAULT_ZONE_PRESENTATION)).toBe('live');
  expect(status(DEFAULT_ZONE_PRESENTATION, legacy)).toBe('live');
  expect(status(undefined, legacy)).toBe('live');
});

test('legacy presentation normalization still detects a changed structural theme', () => {
  const compact = { ...DEFAULT_ZONE_PRESENTATION,
    tokens: { ...DEFAULT_ZONE_PRESENTATION.tokens, density: 'compact' as const } };
  expect(status(legacy, compact)).toBe('behind');
  expect(status(compact, legacy)).toBe('behind');
});
