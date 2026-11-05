import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { AlbumCurrentVisitGate } from '../features/catalogue/album-current-visit';
import { createAlbumCurrentVisitLink, type AlbumCurrentVisitOrigin } from '../features/catalogue/album-current-visit-model';
import { AlbumProfile } from '../features/catalogue/album-profile-view';
import type { AlbumEditors, AlbumTransport } from '../features/catalogue/album-profile';
import { albumFixture, albumId, artistId, roleId, seriesId, partId } from '../kernel/fake/catalogue-album-profile';
import { candidateContext } from '../subject/candidates';
import { subjectVisitReturn } from '../features/pages/subject-visit-navigation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function CurrentCorrection() {
  const locale = getLocale();
  const fixture = useMemo(() => albumFixture('ready', locale), [locale]);
  const origin: AlbumCurrentVisitOrigin = {
    version: 1,
    subject: { id: albumId, type: 'schema:MusicAlbum', label: pickText(fixture.publicRead.subject.labels, locale).text },
    address: `/en/subjects/${albumId}/harbour-sessions#connections`,
    locale,
    context: { id: candidateContext, population: 'global', label: 'Global' },
    release: fixture.publicRead.subject.release,
    reader: 'story-reader',
  };
  const entry = createAlbumCurrentVisitLink(
    `/en/subjects/${albumId}/harbour-sessions/album`,
    origin,
    locale,
    (value, expectedLocale) => subjectVisitReturn(value, expectedLocale),
  );
  const editors = useMemo<AlbumEditors>(() => {
    const read = async () => {
      const result = await fixture.editors.facts.read();
      if (!result.ok) return result;
      const allowed = {
        state: 'available' as const,
        actions: [
          { action: 'statement:propose', operations: ['subject.propose', 'subject.list_candidates'] },
          { action: 'subject:read', operations: ['subject.list_candidates'] },
        ],
      };
      return { ...result, actions: { subject: allowed, context: allowed } };
    };
    return { ...fixture.editors, facts: { ...fixture.editors.facts, read } };
  }, [fixture]);
  const transport = useMemo<AlbumTransport>(
    () => ({
      ...fixture.transport,
      load: async () => {
        const current = await editors.facts.read();
        return current.ok
          ? { ok: true, release: current.release, public: current.public, correction: current }
          : current;
      },
    }),
    [editors, fixture],
  );
  return (
    <PatternStory path={entry.href} visitor="Signed In">
      <AppShell>
        <AlbumCurrentVisitGate
          id={albumId}
          slug="harbour-sessions"
          locale={locale}
          origin={origin}
          token={entry.token}
          renderCorrection={() => (
            <AlbumProfile
              id={albumId}
              locale={locale}
              session="signed-in"
              transport={transport}
              editors={editors}
              search={async (text) =>
                [artistId, roleId, seriesId, partId].flatMap((id) => {
                  const related = fixture.publicRead.related[id]!;
                  const title = pickText(related.labels, locale).text;
                  return title.toLowerCase().includes(text.toLowerCase())
                    ? [{ id, title, types: [related.type!], typeLabel: related.type!, cover: null }]
                    : [];
                })
              }
            />
          )}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Album correction current visit',
  component: CurrentCorrection,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
      },
    },
    docs: {
      description: {
        component:
          'A fixture-backed public-origin Album correction visit. The visible Global choice mounts the current correction workspace and reads current advice; this story is not native or browser acceptance.',
      },
    },
  },
} satisfies Meta<typeof CurrentCorrection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentCorrectionVisit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.album_current_global_choice() }));
    await expect(await canvas.findByRole('region', { name: m.album_identity() })).toBeVisible();
  },
};
