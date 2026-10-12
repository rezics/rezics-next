import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { chooseOption } from '../stories/choose-option.ts';
import type { PageChoice, ZoneCollectionLookupClient } from './api.ts';
import { CollectionPageLookup } from './collection-page-lookup.tsx';
import { copyOf } from './messages.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000801';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000802';

function CollectionLookupStory({ unavailable = false }: { unavailable?: boolean }) {
  const [chosen, setChosen] = useState<PageChoice | null>(null);
  const [api] = useState<ZoneCollectionLookupClient>(() => ({
    async findCollection(link, actingSubject) {
      await expect(link).toBe(target);
      await expect(actingSubject).toBe(actor);
      return unavailable ? { ok: false, failure: 'unavailable' } : { ok: true, data: { target, name: 'Harbor charts' } };
    },
  }));
  return <main className="mx-auto grid max-w-lg gap-4 p-6">
    <h1 className="text-xl font-semibold">Choose an existing Collection</h1>
    <CollectionPageLookup actingSubject={actor} copy={copyOf('en')} disabled={false} signInHref="/auth/start"
      onChoose={setChosen} api={api} />
    {chosen ? <p role="status">Selected {chosen.name}</p> : null}
  </main>;
}

const meta = { title: 'Zone editor/Collection lookup', render: () => <CollectionLookupStory /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExistingCollection: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Collection resource link' }), target);
    await userEvent.click(canvas.getByRole('button', { name: 'Find Collection' }));
    await chooseOption(canvas, 'Harbor charts');
    await expect(canvas.getByRole('status')).toHaveTextContent('Selected Harbor charts');
  },
};

export const UnavailableCollectionKeepsItsLink: Story = {
  render: () => <CollectionLookupStory unavailable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Collection resource link' }), target);
    await userEvent.click(canvas.getByRole('button', { name: 'Find Collection' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('That Collection is not available.');
    await expect(canvas.getByRole('textbox', { name: 'Collection resource link' })).toHaveValue(target);
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('That Collection is not available.');
    await expect(canvas.queryByRole('option')).toBeNull();
  },
};
