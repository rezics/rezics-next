import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErasureProgressView } from '../src/accounts/erasure-progress/view';
import type { Page } from '../src/accounts/erasure-progress/data';

const ready: Page = {
  status: 'ready',
  viewerId: '019a0000-0000-7000-8000-000000000003',
  value: {
    accountId: '019a0000-0000-7000-8000-000000000001',
    state: 'pending',
    at: '2026-10-01T10:00:00.000Z',
    completedAt: null,
    pendingParticipants: ['auth'],
    retentionOutstanding: false,
    lateItems: true,
    effectsFrontier: true,
  },
};

test('each progress navigation, retry and accessible reference belongs to its own view', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  try {
    window.document.body.innerHTML = renderToStaticMarkup(
      <>
        <ErasureProgressView
          page={{ ...ready, value: { ...ready.value, accountId: ready.viewerId } }}
          reload={() => {}}
        />
        <ErasureProgressView page={ready} reload={() => {}} />
        <ErasureProgressView page={{ status: 'unavailable' }} reload={() => {}} />
      </>,
    );
    const ids = Array.from(window.document.querySelectorAll('[id]'), (node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const article of window.document.querySelectorAll('article')) {
      const region = article.querySelector('section[aria-live]')!;
      expect(region.getAttribute('tabindex')).toBe('-1');
      expect(article.querySelector('a')?.getAttribute('href')).toBe(`#${region.id}`);
      expect(article.querySelector('button')?.getAttribute('aria-controls')).toBe(region.id);
      for (const node of article.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]'))
        for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls'])
          for (const id of node.getAttribute(attribute)?.split(' ') ?? [])
            expect(article.contains(window.document.getElementById(id))).toBe(true);
    }
  } finally {
    await window.happyDOM.close();
  }
});
