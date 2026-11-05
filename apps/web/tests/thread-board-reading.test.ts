import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { locales } from '../src/paraglide/runtime.js';
import { NativeDocumentImage } from '../src/threads/document-media-image';
import { ThreadPageError } from '../src/threads/thread-page-error';
import { threadLocation } from '../src/threads/thread-href';

const threadId = '11111111-1111-4111-8111-111111111111';
const boardId = '22222222-2222-4222-8222-222222222222';
const launchLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const touchedLabels = [
  'account_sign_in',
  'board_context_label',
  'subject_community_board',
  'thread_page_invalid_cursor',
  'thread_page_restart',
  'thread_posts_heading',
  'thread_subjects_heading',
  'threads_next_page',
] as const;

test('the worker graph loads website scopes without a TypeScript URL suffix', async () => {
  const source = await readFile(resolve(import.meta.dir, '../src/session/routes.ts'), 'utf8');
  expect(source).toContain("from './website-scopes'");
  expect(source).not.toContain("from './website-scopes.ts'");
});

test('reply continuation keeps the exact supplied cursor and one first-page restart', () => {
  const boardReturn = `/en/boards/${boardId}?sort=new`;
  const next = threadLocation('en', { id: threadId, title: 'A note for the local showcase' }, 'opaque+/cursor==');
  expect(next).toBe(
    `/en/threads/${threadId}/a-note-for-the-local-showcase?cursor=${encodeURIComponent('opaque+/cursor==')}`,
  );
  const restart = threadLocation('en', { id: threadId }, undefined, undefined, undefined, boardReturn);
  expect(restart).toBe(`/en/threads/${threadId}?boardReturn=${encodeURIComponent(boardReturn)}`);
  expect(restart).not.toContain('cursor=');
  const markup = renderToStaticMarkup(createElement(ThreadPageError, { threadId, boardReturn }));
  expect(markup).toContain('This page link is invalid or out of date');
  expect(markup).toContain(`href="${restart.replace(/&/g, '&amp;')}"`);
  expect(markup).not.toContain('cursor=');
});

test('current document images expose their native media identity', () => {
  const markup = renderToStaticMarkup(
    createElement(NativeDocumentImage, { image: null, alt: 'Opening still', locale: 'en', mediaId: threadId }),
  );
  expect(markup).toContain('data-slot="document-image"');
  expect(markup).toContain(`data-media-id="${threadId}"`);
});

test('touched Board thread labels exist in every launch locale', async () => {
  expect(locales).toEqual([...launchLocales]);
  for (const locale of launchLocales) {
    const messages = JSON.parse(
      await readFile(resolve(import.meta.dir, `../messages/${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    for (const key of touchedLabels) {
      expect(typeof messages[key]).toBe('string');
      expect(messages[key]!.trim().length).toBeGreaterThan(0);
    }
  }
});
