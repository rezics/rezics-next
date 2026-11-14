import { afterAll, expect, test } from 'bun:test';
import { act, useEffect, useState } from 'react';
import { installPostReadingDom } from '../../tests/post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole } = await import('@testing-library/dom');
const { WorkbenchRegion } = await import('./workbench-region');
afterAll(() => dom.restore());

test('secondary-region disclosure retains mounted form state and its command owner', async () => {
  let mounts = 0;
  let disposals = 0;
  function PendingReview() {
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => {
      mounts++;
      return () => {
        disposals++;
      };
    }, []);
    return (
      <label>
        Reviewed exact versions
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      </label>
    );
  }
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkbenchRegion title="Publication">
          <PendingReview />
        </WorkbenchRegion>,
      ),
    );
    const trigger = getByRole(host, 'button', { name: 'Publication' }) as HTMLButtonElement;
    const content = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    const input = content.querySelector<HTMLInputElement>('input')!;
    expect(content.hidden).toBe(true);
    await act(async () => trigger.click());
    await act(async () => input.click());
    expect(input.checked).toBe(true);
    await act(async () => trigger.click());
    expect(content.hidden).toBe(true);
    await act(async () => trigger.click());
    expect(content.querySelector('input')).toBe(input);
    expect(input.checked).toBe(true);
    expect(mounts).toBe(1);
    expect(disposals).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  expect(disposals).toBe(1);
});

test('a review that needs attention stays visible through attempted collapse and rerender', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = (attention: boolean) =>
    act(async () =>
      root.render(
        <WorkbenchRegion title="Publication" attention={attention}>
          <p role="alert">Unknown command result. Retry the frozen intent.</p>
        </WorkbenchRegion>,
      ),
    );
  try {
    await render(false);
    const trigger = getByRole(host, 'button', { name: 'Publication' }) as HTMLButtonElement;
    await render(true);
    expect(trigger.disabled).toBe(true);
    expect(getByRole(host, 'alert').textContent).toContain('Retry the frozen intent');
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await render(true);
    expect(getByRole(host, 'alert')).toBeTruthy();
    await render(false);
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
