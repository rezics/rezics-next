// M6 replays the merged journey and its existing seed at 390×844 and 1440×900.
import './g-855-library-import.e2e.ts';

import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import ko from '../features/library/messages/ko.ts';

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
