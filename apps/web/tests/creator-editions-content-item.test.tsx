import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EditionMetadata } from '../src/content-editions/edition-api';

// UNRUN: composed assertions using the actual shared UI; acceptance, native and browser proof remain deferred.
test('Shared creator edition summaries preserve fixed identity state licence and exact independent actions', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/editions' });
  const { CreatorEditionsView } = await import('../src/content-editions/creator-editions-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'fr');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const published: EditionMetadata = {
    editionId: 'edition/固定+?offer=else&x=%#',
    editionRevision: '007/固定+%',
    state: 'published',
    targetSubjectId: 'subject-fixed',
    creatorAccountId: 'creator-supplied',
    revisionId: 'revision-immutable/一',
    sha256: 'a'.repeat(64),
    licence: 'CC BY-SA 4.0 · supplied terms',
    identity: {
      subject: { id: 'subject-fixed', kind: 'available', label: { value: 'こころ — 固定版', language: 'ja' } },
      revisionCreatedAt: '2025-03-08T23:45:00.000Z',
    },
  };
  const draft: EditionMetadata = {
    ...published,
    editionId: 'draft/草稿+?from=else&x=%#',
    editionRevision: '008',
    state: 'draft',
    identity: {
      subject: { id: 'subject-fixed', kind: 'available', label: { value: '未完的故事', language: 'zh-Hant' } },
      revisionCreatedAt: null,
    },
  };
  const withdrawn: EditionMetadata = {
    ...published,
    editionId: 'withdrawn/保留',
    editionRevision: '009',
    state: 'withdrawn',
    identity: { subject: { id: 'subject-fixed', kind: 'withheld', label: null }, revisionCreatedAt: null },
  };
  try {
    host.innerHTML = renderToStaticMarkup(
      <CreatorEditionsView page={{ kind: 'ready', editions: [published, draft, withdrawn], next: null }} />,
    );
    const rows = [...host.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(3);
    const publishedRow = rows[0]!;
    const heading = publishedRow.querySelector('h2')!;
    const primary = publishedRow.querySelector<HTMLAnchorElement>('[data-slot="list-row-link"]')!;
    expect(heading.textContent).toBe('こころ — 固定版');
    expect(heading.getAttribute('lang')).toBe('ja');
    expect(heading.getAttribute('data-content-item-slot')).toBe('title');
    expect(heading.closest('[aria-hidden="true"], .sr-only')).toBeNull();
    expect(heading.id).not.toBe('');
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(primary.getAttribute('aria-label')).toBeNull();
    expect(primary.getAttribute('lang')).toBe('ja');
    expect(primary.getAttribute('href')).toBe(
      '/fr/editions/edition%2F%E5%9B%BA%E5%AE%9A%2B%3Foffer%3Delse%26x%3D%25%23',
    );
    expect(primary.tabIndex).toBe(0);
    const offer = publishedRow.querySelector<HTMLAnchorElement>('[data-content-item-slot="actions"] a')!;
    expect(offer.textContent).toBe(m.creator_editions_offer());
    expect(offer.getAttribute('href')).toBe(
      '/fr/creator/offers/new?editionId=edition%2F%E5%9B%BA%E5%AE%9A%2B%3Foffer%3Delse%26x%3D%25%23',
    );
    expect(publishedRow.querySelectorAll('a')).toHaveLength(2);
    const draftRow = rows[1]!;
    expect(draftRow.querySelector('h2')?.textContent).toBe('未完的故事');
    expect(draftRow.querySelector('h2')?.getAttribute('lang')).toBe('zh-Hant');
    expect(draftRow.querySelector('[data-slot="list-row-link"]')).toBeNull();
    const resume = draftRow.querySelector<HTMLAnchorElement>('a')!;
    expect(resume.textContent).toBe(m.creator_editions_resume());
    expect(resume.getAttribute('href')).toBe(
      '/fr/editions/new?editionId=draft%2F%E8%8D%89%E7%A8%BF%2B%3Ffrom%3Delse%26x%3D%25%23',
    );
    expect(draftRow.querySelectorAll('a')).toHaveLength(1);
    expect(draftRow.textContent).toContain(m.edition_identity_date_missing());
    const withdrawnRow = rows[2]!;
    expect(withdrawnRow.querySelector('h2')?.textContent).toBe(m.edition_identity_withheld());
    expect(withdrawnRow.querySelector('h2')?.getAttribute('lang')).toBeNull();
    expect(withdrawnRow.querySelector('[role="status"]')?.textContent).toBe(m.edition_identity_recovery());
    expect(withdrawnRow.querySelector('a, button, [data-content-item-slot="actions"]')).toBeNull();

    // Fixed facts and the disclosure use the shared raised layer, outside primary navigation.
    expect(publishedRow.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
      m.creator_editions_published(),
    );
    expect(draftRow.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(m.creator_editions_draft());
    expect(withdrawnRow.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
      m.creator_editions_withdrawn(),
    );
    expect(publishedRow.textContent).toContain(m.edition_identity_revision_date({ date: '8 mars 2025 à 23:45 UTC' }));
    for (const [index, edition] of [published, draft, withdrawn].entries()) {
      const row = rows[index]!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.parentElement?.className).not.toMatch(/divide-|border/);
      expect(
        row.querySelector('li, a a, a button, a summary, h2 a, img, [data-content-item-slot="visual"]'),
      ).toBeNull();
      const metadata = row.querySelector('[data-content-item-slot="metadata"]')!;
      expect(metadata.querySelector('p')?.textContent).toBe(
        m.creator_editions_version({ version: edition.editionRevision }),
      );
      const licence = metadata.querySelector('dl')!;
      expect(licence.querySelector('dt')?.textContent).toBe(m.creator_editions_licence());
      expect(licence.querySelector('dd')?.textContent).toBe(edition.licence);
      const details = metadata.querySelector('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe(m.edition_identity_details());
      expect(details.querySelector('summary')?.classList.contains('min-h-11')).toBe(true);
      expect([...details.querySelectorAll('dd')].map((entry) => entry.textContent)).toEqual([
        edition.editionId,
        edition.targetSubjectId,
        edition.revisionId,
        edition.editionRevision,
        edition.sha256,
      ]);
      expect([...details.querySelectorAll('dd')].every((entry) => entry.classList.contains('select-all'))).toBe(true);
      expect(details.closest('[data-slot="list-row-control"]')).toBe(metadata);
      expect(details.closest('a')).toBeNull();
    }
    for (const action of [offer, resume]) {
      expect(action.closest('[data-slot="list-row-control"]')?.getAttribute('data-content-item-slot')).toBe('actions');
      expect(action.classList.contains('min-h-11')).toBe(true);
      action.focus();
      expect(window.document.activeElement).toBe(action);
      expect(action.closest('a') === primary).toBe(false);
    }

    // An absent identity and a supplied missing title remain different, without inferred subject facts.
    const { identity: _identity, ...unavailable } = published;
    const missing: EditionMetadata = {
      ...withdrawn,
      identity: { subject: { id: 'subject-fixed', kind: 'missing', label: null }, revisionCreatedAt: null },
    };
    host.innerHTML = renderToStaticMarkup(
      <CreatorEditionsView page={{ kind: 'ready', editions: [unavailable, missing], next: null }} />,
    );
    const recoveryRows = [...host.querySelectorAll('ul > li')];
    expect(recoveryRows[0]!.querySelector('h2')?.textContent).toBe(m.edition_identity_unavailable());
    expect(recoveryRows[1]!.querySelector('h2')?.textContent).toBe(m.edition_identity_missing());
    expect(recoveryRows[0]!.querySelector('[data-slot="list-row-link"]')?.getAttribute('href')).toBe(
      primary.getAttribute('href'),
    );
    for (const row of recoveryRows) {
      expect(row.querySelector('[role="status"]')?.textContent).toBe(m.edition_identity_recovery());
      expect(row.querySelector('h2')?.getAttribute('lang')).toBeNull();
      expect(row.textContent).toContain(m.edition_identity_date_missing());
      expect(row.textContent).not.toContain('こころ');
      expect(
        row.querySelector(
          'img, a[href*="/subjects/"], [data-content-item-slot="visual"], [data-content-item-slot="preview"]',
        ),
      ).toBeNull();
      expect(row.textContent).not.toMatch(/USD|EUR|\$|€|price|benefit/i);
    }
    // Native continuation fragments resolve only to a currently admitted, keyboard-focusable page.
    for (const [editions, nextCursor] of [
      [[draft], 'next/+='],
      [[], 'next/+='],
      [[], null],
    ] satisfies [EditionMetadata[], string | null][]) {
      host.innerHTML = renderToStaticMarkup(
        <CreatorEditionsView page={{ kind: 'ready', editions, next: nextCursor }} cursor="current/+=" />,
      );
      const links = [...host.querySelectorAll<HTMLAnchorElement>('a')];
      const continuation = links.find((link) => link.textContent === m.creator_editions_restart());
      if (continuation) expect(continuation.getAttribute('href')).toBe('/fr/editions#creator-editions-inventory');
      const next = links.find((link) => link.textContent === m.creator_editions_next());
      if (next) expect(next.getAttribute('href')).toBe('/fr/editions?cursor=next%2F%2B%3D#creator-editions-inventory');
      const boundary = host.querySelector<HTMLElement>(continuation!.hash)!;
      expect(window.document.activeElement).not.toBe(boundary);
      expect(boundary.tabIndex).toBe(-1);
      expect(boundary.getAttribute('aria-labelledby')).toBe('creator-editions-heading');
      expect(boundary.getAttribute('aria-describedby')).toBe(editions.length ? null : 'creator-editions-empty');
      boundary.focus();
      expect(window.document.activeElement).toBe(boundary);
      expect(links.find((link) => link.textContent === m.creator_editions_refresh())?.hash).toBe('');
    }
  } finally {
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
  }
});
