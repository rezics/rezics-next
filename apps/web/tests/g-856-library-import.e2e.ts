// M6 replays the merged journey and its existing seed at 390×844 and 1440×900.
import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import ko from '../features/library/messages/ko.ts';
import { registerLibraryImportJourney } from './journeys/library-import.ts';

registerLibraryImportJourney([
  { locale: 'en', viewport: { width: 1440, height: 900 } },
  { locale: 'ko', viewport: { width: 390, height: 844 } },
]);

// The exit cannot pass by returning early on a denied Library page.
test.afterEach(async ({ page }) => {
  for (const [locale, words] of [
    ['en', messages],
    ['ko', { ...messages, ...ko }],
  ] as const) {
    const t = materializeData(words, { locale });
    await expect(page.getByRole('heading', { name: t.deniedTitle })).toHaveCount(0);
  }
});
