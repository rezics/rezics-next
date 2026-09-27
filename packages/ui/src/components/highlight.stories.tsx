import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Highlight } from './highlight.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-xl bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Display/Highlight',
  component: Highlight,
  tags: ['autodocs'],
  decorators: [surface],
  args: {
    text: 'The Dispossessed is an anarchist utopia by Ursula K. Le Guin, winner of the Hugo and Nebula awards.',
    query: 'Le Guin',
    ignoreCase: true,
  },
  parameters: {
    docs: {
      description: {
        component:
          'Marks the parts of a string that match a query, as in search results, the command palette or a filtered member list. Matches render as `<mark>` on the accent surface with its text-safe tone. Pass several queries to mark every term, and `ignoreCase` for Latin text; CJK queries match as substrings.',
      },
    },
  },
} satisfies Meta<typeof Highlight>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const marks = canvasElement.querySelectorAll('mark');
    await expect(marks).toHaveLength(1);
    await expect(marks[0]).toHaveTextContent('Le Guin');
  },
};

export const MultipleTerms: Story = {
  args: { query: ['hugo', 'nebula'] },
  async play({ canvasElement }) {
    await expect(canvasElement.querySelectorAll('mark')).toHaveLength(2);
  },
};

export const NoMatch: Story = {
  args: { query: 'Asimov' },
  async play({ canvasElement }) {
    await expect(canvasElement.querySelectorAll('mark')).toHaveLength(0);
  },
};

export const Chinese: Story = {
  name: 'zh-CN and mixed',
  args: {
    text: '《三体》是刘慈欣创作的长篇科幻小说，英文版 The Three-Body Problem 获得 2015 年 Hugo Award。',
    query: ['三体', 'Hugo'],
  },
  render: (args) => (
    <p lang="zh-CN">
      <Highlight {...args} />
    </p>
  ),
};

const SearchAsYouType = () => {
  const [query, setQuery] = useState('');
  const titles = ['The Three-Body Problem', 'The Dark Forest', "Death's End", 'Ball Lightning'];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Filter Works
        <input
          className="h-9 rounded-xl border border-border/80 bg-primary/5 px-4"
          onChange={(event) => setQuery(event.target.value)}
          value={query}
        />
      </label>
      <ul className="flex flex-col gap-1 text-sm">
        {titles.map((title) => (
          <li key={title}>
            <Highlight ignoreCase query={query} text={title} />
          </li>
        ))}
      </ul>
    </div>
  );
};

export const Interactive: Story = {
  render: () => <SearchAsYouType />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Filter Works' }), 'the');
    await expect(canvasElement.querySelectorAll('mark').length).toBeGreaterThanOrEqual(2);
  },
};

export const Dark: Story = {
  parameters: { dark: true },
  args: { query: ['Le Guin', 'Hugo'] },
};
