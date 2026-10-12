import { expect, test } from 'bun:test';
import type { ZoneConfiguration } from '../../../services/main/src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, type ZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { publicNavigationFixture } from './zone-public-navigation-support.ts';

interface SavedSelection {
  revision: string;
  configuration: ZoneConfiguration;
  draft: { variantId: string; revisionId: string | null };
  preview: { publicationStatus: 'private' | 'live' | 'behind'; presentation: ZonePresentation;
    navigation: { revision: string } };
}

test('saved preview publication status covers Content, navigation, layout and presentation links', async () => {
  const f = await publicNavigationFixture();
  try {
    const preview = () => f.call('GET', `${f.path}/showcase-editor?actingSubject=${encodeURIComponent(f.actor)}`);
    const saved = async () => f.json<SavedSelection>(await preview(), 200);
    const configure = async (presentation: ZonePresentation) => f.json<{ revision: string }>(
      await f.call('PUT', `${f.path}/configuration`, {
        expectedHead: (await saved()).revision,
        presentation, actingSubject: f.actor,
      }), 200);

    expect((await saved()).preview.publicationStatus).toBe('private');
    let page = await f.save();
    const unpublished = await saved();
    expect(unpublished.preview.publicationStatus).toBe('private');
    expect(unpublished.configuration.presentation).toBeUndefined();
    let navigationRevision = f.navigationRevision;
    const publication = await f.publish(navigationRevision, page);
    expect(publication.revision).not.toBe(unpublished.revision);
    const unchanged = await saved();
    expect(unchanged).toMatchObject({ revision: publication.revision, draft: { revisionId: page.revisionId },
      preview: { publicationStatus: 'live', presentation: DEFAULT_ZONE_PRESENTATION } });

    // Explicit defaults change the stored representation, but keep its meaning.
    await configure(DEFAULT_ZONE_PRESENTATION);
    expect((await saved()).preview.publicationStatus).toBe('live');
    await f.publish(navigationRevision, page);

    const mounted = await f.json<{ revision: string }>(await f.call('POST', `${f.path}/mounts`, {
      expectedHead: navigationRevision, target: f.targets[0], routeSegment: 'reading',
      disclosure: 'public', actingSubject: f.actor,
    }), 200);
    navigationRevision = mounted.revision;
    const navigationOnly = await saved();
    expect(navigationOnly).toMatchObject({ draft: { revisionId: page.revisionId },
      preview: { publicationStatus: 'behind', navigation: { revision: navigationRevision },
        presentation: DEFAULT_ZONE_PRESENTATION } });
    await f.publish(navigationRevision, page);
    expect((await saved()).preview.publicationStatus).toBe('live');

    const structuralTheme: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
      tokens: { ...DEFAULT_ZONE_PRESENTATION.tokens, density: 'compact', pageSurface: 'cards' } };
    await configure(structuralTheme);
    const themeOnly = await saved();
    expect(themeOnly).toMatchObject({ draft: { revisionId: page.revisionId },
      preview: { publicationStatus: 'behind', navigation: { revision: navigationRevision },
        presentation: { tokens: structuralTheme.tokens } } });
    await f.publish(navigationRevision, page);
    expect((await saved()).preview.publicationStatus).toBe('live');

    const linked: ZonePresentation = { ...structuralTheme,
      navigation: [{ label: 'Reading guide', href: '/reading' }] };
    await configure(linked);
    const linksOnly = await saved();
    expect(linksOnly).toMatchObject({ draft: { revisionId: page.revisionId },
      preview: { publicationStatus: 'behind', navigation: { revision: navigationRevision },
        presentation: { tokens: structuralTheme.tokens, navigation: linked.navigation } } });
    await f.publish(navigationRevision, page);
    expect((await saved()).preview.publicationStatus).toBe('live');

    page = await f.save(page);
    const contentOnly = await saved();
    expect(contentOnly).toMatchObject({ draft: { revisionId: page.revisionId },
      preview: { publicationStatus: 'behind', navigation: { revision: navigationRevision },
        presentation: linked } });
    await f.publish(navigationRevision, page);
    expect((await saved()).preview.publicationStatus).toBe('live');
  } finally { await f.close(); }
}, 180_000);
