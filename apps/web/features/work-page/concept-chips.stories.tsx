import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlobeIcon, UsersRoundIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { FacetRows } from './concept-chips.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';

const items = fixture.globalClassifications.ok ? fixture.globalClassifications.data.items : [];
const local = fixture.realmClassifications.ok ? fixture.realmClassifications.data.items : [];
const realm = fixture.realms[0]!.id;

const meta = {
  title: 'Work page/Concept chips', component: FacetRows,
  args: { rows: [{ key: 'tags', label: 'Tags', groups: [{ key: 'global', items, scope: { kind: 'global' } }] }],
    locale: 'en', messages: messages.en },
  decorators: [Story => <div className="max-w-3xl p-6"><Story /></div>],
  parameters: { route: { pathname: `/en/w/${fixture.workRef}` } },
} satisfies Meta<typeof FacetRows>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One Facet's values beside its label, most relevant first, each opening its Concept page. */
export const Tags: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('term')).toHaveTextContent('Tags');
    await expect(canvas.getByRole('link', { name: /Maritime fiction/ })).toHaveAttribute('href',
      expect.stringMatching(/^\/en\/concepts\/[0-9a-f-]{36}$/));
  },
};

/** Several Facets, one row each, as AO3 lists a work's tags by type ("Genre: Fantasy · Tags: 後宮"). */
export const SeveralFacets: Story = {
  args: { rows: [
    { key: 'genre', label: 'Genre', groups: [{ key: 'global', items: items.slice(0, 2), scope: { kind: 'global' } }] },
    { key: 'tags', label: 'Tags', groups: [{ key: 'global', items: items.slice(2), scope: { kind: 'global' } }] },
  ] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('term').map(term => term.textContent)).toEqual(['Genre', 'Tags']);
  },
};

/** In a community, its own values and those it inherits are listed apart, all opening the community's page. */
export const Community: Story = {
  args: { rows: [{ key: 'tags', label: 'Tags', groups: [
    { key: 'local', items: local.filter(item => item.source === 'local'), scope: { kind: 'realm', realm },
      caption: { icon: UsersRoundIcon, label: 'Accepted in Tidewater Readers' } },
    { key: 'global', items: local.filter(item => item.source === 'global'), scope: { kind: 'realm', realm },
      caption: { icon: GlobeIcon, label: 'Accepted by everyone' } },
  ] }] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const inherited = within(canvas.getByRole('list', { name: 'Accepted by everyone' }));
    await expect(inherited.getByRole('link', { name: 'Adventure' })).toHaveAttribute('href',
      expect.stringMatching(new RegExp(`^/en/concepts/[0-9a-f-]{36}\\?scope=realm&realm=${realm}$`)));
  },
};

export const ChineseDark: Story = {
  args: { rows: [{ key: 'tags', label: '标签', groups: [{ key: 'global', items, scope: { kind: 'global' } }] }],
    locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('term')).toHaveTextContent('标签');
  },
};
