import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';
import { ZoneDraftPreview } from './preview.tsx';
import { savedPreviewReaders } from './saved-preview-frame.fixtures.ts';
import { loadSavedPreviewFrame, type SavedPreviewFrameLoad } from './saved-preview-frame.ts';
import { ZoneSavedPreviewFrame } from './saved-preview-frame.tsx';
import { ZoneAuthoringFailure } from './states.tsx';

function SavedFrame({ realm }: { realm: boolean }) {
  const [loaded, setLoaded] = useState<SavedPreviewFrameLoad | null>(null);
  useEffect(() => {
    void loadSavedPreviewFrame(savedPreviewReaders(realm), {
      locale: 'en', homeName: 'Home', lookEnabled: true,
    }).then(setLoaded);
  }, [realm]);
  if (!loaded || loaded.kind === 'missing') return null;
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure copy={messages.en} failure={loaded.failure} />;
  if (Boolean(loaded.frame.saved.realm) !== realm) return null;
  const { frame } = loaded;
  const { model, preview, sitePath, editorPath } = frame.saved;
  return <ZoneSavedPreviewFrame frame={frame} readerTheme="light">
    <PageContainer><ZoneDraftPreview copy={messages.en} document={model.document} status={preview.publicationStatus}
      sitePath={sitePath} editorPath={editorPath} pageSurface={frame.cuts.tokens.pageSurface} /></PageContainer>
  </ZoneSavedPreviewFrame>;
}

const meta = { title: 'Zone editor/Saved frame', component: SavedFrame,
  parameters: { route: { pathname: '/en/manage/z/harbor/preview' } }, args: { realm: false },
} satisfies Meta<typeof SavedFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

async function checkSavedFrame(canvasElement: HTMLElement, realm: boolean) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: 'Saved harbor notes' })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
  await expect(canvas.getByText('This saved page survives an unavailable public home.')).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Back to the editor' })).toBeVisible();
  const navigation = within(canvasElement.querySelector<HTMLElement>('[data-zone-site-navigation]')!);
  await expect(navigation.getAllByRole('link').map(link => link.textContent))
    .toEqual(['Home', 'Saved visitor guide', 'Harbor charts']);
  await expect(canvas.queryByText('Private records')).not.toBeInTheDocument();
  if (realm) await expect(canvas.getByRole('link', { name: 'Community' })).toBeVisible();
  else await expect(canvas.queryByRole('link', { name: 'Community' })).not.toBeInTheDocument();
  const frame = canvasElement.querySelector<HTMLElement>('[data-zone]')!;
  await expect(frame.dataset.zoneMode).toBe('fallback');
  await expect(frame.style.getPropertyValue('--zone-tiles')).toBe('6');
  await expect(frame.style.getPropertyValue('--zone-panel')).toBe('var(--card)');
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

/** Main's public presentation and Realm enrichment are unavailable; authorized saved data still renders. */
export const SavedRealmWithUnavailablePublicHome: Story = { args: { realm: true },
  async play({ canvasElement }) { await checkSavedFrame(canvasElement, true); } };
export const SavedStandaloneWithUnavailablePublicHome: Story = {
  args: { realm: false },
  async play({ canvasElement }) { await checkSavedFrame(canvasElement, false); } };
export const SavedRealmPhone: Story = { ...SavedRealmWithUnavailablePublicHome,
  globals: { viewport: { value: 'phone' } } };
