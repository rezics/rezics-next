import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { classificationRow, classificationsPage, frontier } from './own-classification-assessments-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
});

test('inspection retires on source replacement and old selection callbacks cannot revive it', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  const root = createRoot(host);
  const page = classificationsPage();
  let active = true;
  const render = (currentPage = page) =>
    root.render(
      <OwnClassificationsWorkspace
        state="ready"
        page={currentPage}
        frontier={frontier}
        locale="en"
        isCurrent={() => active}
        onRetry={async () => {}}
        onNext={() => {}}
      />,
    );
  try {
    await act(async () => render());
    const old = host.querySelector('button')!;
    await act(async () => old.click());
    expect(host.querySelector('section')?.textContent).toContain('Original Subject and association');
    expect(
      [...host.querySelectorAll('a')].every(
        (link) => link.href.includes('/en/subjects/') && !link.href.includes('/v1/'),
      ),
    ).toBe(true);
    await act(async () => render(classificationsPage([classificationRow()])));
    expect(host.querySelector('section')).toBeNull();
    await act(async () => old.click());
    expect(host.querySelector('section')).toBeNull();
    active = false;
    await act(async () => render());
    expect(host.textContent).not.toContain('Own-page subject');
    expect(host.querySelector('a')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
