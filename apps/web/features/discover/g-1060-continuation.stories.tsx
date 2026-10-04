import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Providers } from '../shell/providers.tsx';
import { browseResources, fixtureTopicLoader } from './browse-fixtures.ts';
import { browseMessages } from './browse-messages.ts';
import { emptyBrowse } from './browse-state.ts';
import { DiscoverView } from './discover-view.tsx';

function choose(anchor: HTMLAnchorElement) {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(click);
}

function Continuation({ early = false, section = false }: { early?: boolean; section?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const originals = useRef(new WeakMap<HTMLAnchorElement, string>());
  const [handled, setHandled] = useState<boolean[]>([]);
  useLayoutEffect(() => {
    const previous = window.location.href;
    if (early) {
      // A hydration replay can run before LocalizedLink's enhancement effect.
      choose(root.current!.querySelector<HTMLAnchorElement>('a[rel="next"]')!);
    }
    return () => {
      window.history.replaceState(null, '', previous);
    };
  }, [early]);
  const page = {
    items: browseResources.filter((item) => item.kind === 'realm').slice(0, 6),
    count: { kind: 'at-least' as const, value: 26 },
    complete: false,
    nextCursor: 'next-community-page',
  };
  return (
    <div
      ref={root}
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
        if (!anchor?.getAttribute('href')?.includes('/discover')) return;
        originals.current.set(anchor, anchor.getAttribute('href')!);
        const url = new URL(anchor.href);
        // Keep the real component and handler; only the document destination stays
        // inside this iframe. The app-router stand-in never prevents the click.
        anchor.href = url.searchParams.has('cursor') ? '#g1060-more' : '#g1060-first';
      }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
        if (!anchor || !originals.current.has(anchor)) return;
        const prevented = event.defaultPrevented;
        setHandled((previous) => [...previous, prevented]);
        event.preventDefault();
        anchor.setAttribute('href', originals.current.get(anchor)!);
      }}
    >
      <Providers>
        <DiscoverView
          locale="en"
          state={{
            ...emptyBrowse,
            tab: section ? 'all' : 'communities',
            section: section ? 'communities' : null,
            cursor: 'current-community-page',
          }}
          topics={[]}
          topicLoad={fixtureTopicLoader()}
          sections={
            section
              ? { ok: true, data: [{ id: 'communities', reason: { kind: 'communities' }, page }] }
              : null
          }
          results={section ? null : { ok: true, data: page }}
        />
      </Providers>
      <output aria-label="Document choices">{handled.join(',')}</output>
    </div>
  );
}

const meta = { title: 'Discover/Continuation navigation', component: Continuation } satisfies Meta<
  typeof Continuation
>;
export default meta;
type Story = StoryObj<typeof meta>;

async function checkContinuation(canvasElement: HTMLElement, early = false) {
  const canvas = within(canvasElement);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  if (early) {
    await expect(canvas.getByLabelText('Document choices')).toHaveTextContent('true');
    await waitFor(() => expect(window.location.hash).toBe('#g1060-more'));
  }
  const first = canvas.getByRole('link', { name: browseMessages.en.first });
  const more = canvas.getByRole('link', { name: browseMessages.en.more });
  // A newer click may supersede More; passive effects and older choices may not.
  choose(more as HTMLAnchorElement);
  choose(first as HTMLAnchorElement);
  await waitFor(() => expect(window.location.hash).toBe('#g1060-first'));
  await expect(canvas.getByLabelText('Document choices')).toHaveTextContent(
    early ? 'true,true,true' : 'true,true',
  );
  await expect(more).toHaveAttribute('href', expect.stringContaining('cursor=next-community-page'));
  await expect(first).not.toHaveAttribute('href', expect.stringContaining('cursor='));
  first.focus();
  await userEvent.keyboard('{Enter}');
  await expect(first).toHaveFocus();
  const modified = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ctrlKey: true,
  });
  first.dispatchEvent(modified);
  // The wrapper records defaultPrevented after the real anchor handler runs.
  await waitFor(() =>
    expect(canvas.getByLabelText('Document choices')).toHaveTextContent(/true,false$/),
  );
}

export const AfterEffects: Story = {
  async play({ canvasElement }) {
    await checkContinuation(canvasElement);
    if ('__vitest_browser__' in globalThis) {
      const { page } = await import('vitest/browser');
      await document.fonts.ready;
      for (const width of [1280, 390]) {
        await page.viewport(width, 860);
        const capture = {
          path: `../../../../.temp/g-1060/continuation-${width}.png`,
          fullPage: true,
        };
        await page.screenshot(capture);
      }
    }
  },
};
export const AcrossHydration: Story = {
  args: { early: true },
  async play({ canvasElement }) {
    await checkContinuation(canvasElement, true);
  },
};
export const SectionContinuation: Story = {
  args: { section: true },
  async play({ canvasElement }) {
    await checkContinuation(canvasElement);
  },
};
