import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveEntryRecoveryPage } from '../src/library/archive-entry-recovery';
import { libraryNavigation } from '../src/library/navigation';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

test('Library offers a distinct signed-in archive recovery destination beside export and provider imports', () => {
  const recovery = libraryNavigation.find((item) => item.href === '/library/recover-archive');
  expect(recovery).toMatchObject({ signedIn: true, match: 'exact', group: 'personal' });
  expect(libraryNavigation.some((item) => item.href === '/library/export')).toBe(true);
  expect(libraryNavigation.some((item) => item.href === '/library/import-mal')).toBe(true);
});

test('Every locale explains unavailable upload, explicit mapping and unsupported scope without accepting a file', () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(<ArchiveEntryRecoveryPage />);
      const escaped = (text: string) => renderToStaticMarkup(<span>{text}</span>).slice(6, -7);
      for (const text of [
        m.library_archive_unavailable(),
        m.library_archive_keep_file(),
        m.library_archive_supported(),
        m.library_archive_outside(),
        m.library_archive_inventory(),
        m.library_archive_deliberate(),
      ])
        expect(html).toContain(escaped(text));
      expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
      expect(html).toContain('aria-describedby="archive-file-help"');
      expect(html).toContain('aria-current="step"');
      expect(html).toContain(`href="/${locale}/library"`);
      expect(html).toContain(`href="/${locale}/library/export"`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('data-upload-id');
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
