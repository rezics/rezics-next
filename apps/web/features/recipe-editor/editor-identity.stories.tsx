import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { resourceHref } from '../address/path.ts';
import { RecipeEditor } from './editor.tsx';
import { actingSubject, detailsValues, emptyStart, fakeMain, id, mainVersion, noNotes, work } from './fixtures.ts';
import { copyOf, messages } from './messages.ts';

const details = (title: string) => ({ ...detailsValues, entries: [{ ...detailsValues.entries[0]!, title }] });
let visits: ReturnType<typeof fakeMain>[];

function EditorNavigation() {
  const [worlds] = useState(() => (visits = ['Lemon muffins', 'Tomato soup'].map((title, index) =>
    fakeMain({ recipe: emptyStart, details: details(title), metadataHead: id(700 + index) }))));
  const [selected, setSelected] = useState(0);
  return <div className="mx-auto grid max-w-6xl gap-4 p-6">
    <button type="button" onClick={() => setSelected(1)}>Open next recipe</button>
    <RecipeEditor work={selected ? id(500) : work} mainVersion={selected ? id(501) : mainVersion}
      actingSubject={actingSubject} language="en" workHref={resourceHref('/w/', (selected ? id(500) : work).slice(-36))}
      locale="en" messages={messages.en} main={worlds[selected]!.main}
      initial={{ recipe: emptyStart, notes: { ...noNotes, body: selected ? 'Soup notes' : 'Muffin notes' },
        details: { head: id(700 + selected), values: details(selected ? 'Tomato soup' : 'Lemon muffins') } }} />
  </div>;
}

const meta = { title: 'Recipe editor/Navigation', component: EditorNavigation } satisfies Meta<typeof EditorNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;
const t = copyOf('en');

export const OpensAnotherRecipe: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('textbox', { name: t.title })).toHaveValue('Lemon muffins');
  await userEvent.click(canvas.getByRole('button', { name: 'Open next recipe' }));
  await expect(canvas.getByRole('textbox', { name: t.title })).toHaveValue('Tomato soup');
  await expect(canvas.getByRole('textbox', { name: t.notes })).toHaveValue('Soup notes');
  const title = canvas.getByRole('textbox', { name: t.title });
  await userEvent.clear(title);
  await userEvent.type(title, 'Roasted tomato soup');
  await userEvent.tab();
  await waitFor(() => expect(visits[1]!.calls.filter(call => call.name === 'details')).toHaveLength(1));
  await expect(visits[0]!.calls).toHaveLength(0);
} };
