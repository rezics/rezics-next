import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrivateFollowCountsPageView } from '../src/library/private-follow-counts-page';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';

test('malformed target context can be corrected with validated GET fields or cleared to own counts', () => {
  const window = new Window({ url: 'https://site.test/en/library/follow-counts' });
  const host = window.document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(PrivateFollowCountsPageView, {
      page: { context: { invalidContext: true }, outgoing: { state: 'ready', count: 0 }, target: null },
    }),
  );

  const form = host.querySelector('form')!;
  const type = host.querySelector<HTMLSelectElement>('select[name="targetType"]')!;
  const id = host.querySelector<HTMLInputElement>('input[name="targetId"]')!;
  expect(form.method).toBe('get');
  const destination = new URL(form.action);
  const clear = host.querySelector<HTMLAnchorElement>('a')!;
  expect(destination.pathname.endsWith('/library/follow-counts')).toBe(true);
  expect(new URL(clear.href).pathname).toBe(destination.pathname);
  expect(new URL(clear.href).search).toBe('');
  expect(type.labels).toHaveLength(1);
  expect(id.labels).toHaveLength(1);
  expect(id.getAttribute('aria-describedby')).toBe('follow-count-context-id-help');
  expect(form.checkValidity()).toBe(false);
  type.value = 'collection';
  id.value = 'malformed';
  let submitted = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted = true;
  });
  type.focus();
  form.requestSubmit();
  expect(submitted).toBe(false);
  expect(window.document.activeElement).toBe(id);
  expect(id.value).toBe('malformed');
  id.value = targetId;
  expect(form.checkValidity()).toBe(true);
  expect(host.querySelector('a[href="/en/library/follow-counts"]')?.textContent).toContain('Clear resource context');
  window.happyDOM.abort();
});
