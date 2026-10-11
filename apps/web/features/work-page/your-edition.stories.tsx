import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { editions as fixture, iri, saoOne } from '../tracking/fixtures.ts';
import { createMemoryMain, memoryReader, type MemoryMain } from '../tracking/memory.ts';
import type { Editions } from '../tracking/types.ts';
import { messages } from './messages.ts';
import { YourEdition } from './your-edition.tsx';

// Identical titles are deliberate: the choice must identify the actual release.
const editions: Editions = { realizations: [], more: false, releases: [
  { ...fixture.releases[0]!, id: iri('b1'), revision: iri('b19'), title: { value: 'Pride and Prejudice', language: 'en' },
    platform: 'paperback', publisher: 'Dell Publishing Co. Inc.', publicationYear: 1960, editionStatement: null },
  { ...fixture.releases[0]!, id: iri('b2'), revision: iri('b29'), title: { value: 'Pride and Prejudice', language: 'en' },
    platform: 'ebook', publisher: 'Penguin USA, Inc.', publicationYear: 2009, editionStatement: null },
  { ...fixture.releases[0]!, id: iri('b3'), revision: iri('b39'), title: { value: 'Pride and Prejudice', language: 'en' },
    platform: 'audiobook', publisher: 'Librivox', publicationYear: 2006, editionStatement: null },
] };

function Chooser({ main }: { main: MemoryMain }) {
  const [actions] = useState(() => memoryReader(main, {}));
  return <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <section className="mx-auto grid max-w-3xl gap-4 px-4 py-8" aria-label="Your edition and availability">
      <h2 className="text-lg font-semibold">Your edition and availability</h2>
      <YourEdition work={saoOne} signInHref="/auth/start" locale="en" messages={messages.en} />
    </section>
  </ReaderActionsProvider>;
}

const meta = { title: 'Work page/Your edition', component: Chooser,
  args: { main: createMemoryMain({ editions }) } } satisfies Meta<typeof Chooser>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SameTitleEditions: Story = {
  args: { main: createMemoryMain({ editions }) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const select = await canvas.findByRole('combobox', { name: 'Edition' });
    await userEvent.click(select);
    const options = within(document.body).getAllByRole('option');
    const names = options.map(option => option.textContent);
    await expect(new Set(names).size).toBe(names.length);
    const audiobook = within(document.body).getByRole('option', {
      name: 'Pride and Prejudice · Audiobook · English · Librivox · 2006' });
    await waitFor(() => expect(audiobook).toBeVisible());
    await expect(within(document.body).getByRole('option', {
      name: 'Pride and Prejudice · paperback · English · Dell Publishing Co. Inc. · 1960' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(audiobook);
    await userEvent.click(canvas.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => expect(args.main.preferences.get(saoOne)).toMatchObject({ language: 'en',
      edition: { kind: 'release', resource: iri('b3'), revision: iri('b39') } }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Saved.');
  },
};

export const SameTitleEditionsPhone: Story = { ...SameTitleEditions,
  args: { main: createMemoryMain({ editions }) }, globals: { viewport: { value: 'phone' } } };
