import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveEntryRecoveryView } from '../src/library/archive-entry-recovery/page';
import { ArchiveEntryRecoveryJourney } from '../src/library/archive-entry-recovery/controller';
import { archiveRecoveryNative } from '../src/library/archive-entry-recovery/native';
import { createKernelClient } from '@rezics/client';
import { libraryNavigation } from '../src/library/navigation';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, overwriteGetLocale } from '../src/paraglide/runtime.js';

const binding = {
  viewer: 'owner',
  credentialEpoch: 'epoch',
  csrfEpoch: 'epoch',
  source: 'archive',
  route: '/library/recover-archive',
  locale: 'en',
  exposure: 'open',
};

test('Library offers a distinct signed-in archive recovery destination beside export and provider imports', () => {
  expect(libraryNavigation.find((item) => item.href === '/library/recover-archive')).toMatchObject({
    signedIn: true,
    match: 'exact',
    group: 'personal',
  });
  expect(libraryNavigation.some((item) => item.href === '/library/export')).toBe(true);
  expect(libraryNavigation.some((item) => item.href === '/library/import-mal')).toBe(true);
});

test('Every locale mounts native file admission and explains the supported branch and limits', () => {
  const previous = getLocale;
  const native = archiveRecoveryNative(createKernelClient('https://kernel.test'), 'Bearer owner');
  const journey = new ArchiveEntryRecoveryJourney(native, () => binding, Date.now() + 60_000);
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      const html = renderToStaticMarkup(<ArchiveEntryRecoveryView journey={journey} />);
      const escaped = (text: string) => renderToStaticMarkup(<span>{text}</span>).slice(6, -7);
      for (const text of [
        m.library_archive_entry_upload_help(),
        m.library_archive_entry_scope(),
        m.library_archive_personal_help(),
        m.library_archive_deliberate(),
      ])
        expect(html).toContain(escaped(text));
      for (const label of [
        m.library_window_previous(),
        m.library_archive_entry_first(),
        m.library_archive_entry_next(),
        m.library_archive_entry_results_refresh(),
        m.library_window_retry(),
      ])
        expect(label.length).toBeGreaterThan(0);
      expect(html).toMatch(/<input[^>]*type="file"/);
      expect(html).not.toMatch(/<input[^>]*type="file"[^>]*\sdisabled=""/);
      expect(html).toContain('aria-describedby="archive-file-help"');
      expect(html).toContain('aria-current="step"');
      expect(html).toContain(`href="/${locale}/library"`);
      expect(html).toContain(`href="/${locale}/library/export"`);
      expect(html).not.toContain('data-upload-id');
    }
  } finally {
    journey.retire();
    overwriteGetLocale(previous);
  }
});
