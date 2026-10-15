import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { editingHref } from './agent.ts';
import { agents, ids, inventory, now } from './fixtures.ts';
import { messages } from './messages.ts';
import { readInventory, type InventoryView } from './read.ts';
import { StudioFrame } from './studio-frame.tsx';
import { StudioHome, StudioHomePending } from './studio-home.tsx';
import type { Loaded, MainClient } from './types.ts';
import { recipeProveStates } from '../recipe-editor/prove-states.ts';
import { localizedPath } from '../../i18n/locale.ts';

const agent = agents[0]!;
function RecipeStudio({ state }: { state: 'populated' | 'empty' | 'error' | 'loading' }) {
  const [loaded, setLoaded] = useState<Loaded<InventoryView> | null>(null);
  useEffect(() => {
    let mounted = true;
    let release: (() => void) | undefined;
    const main = { v1: { me: { agents: () => ({ works: { get: async () => {
      if (state === 'loading') await new Promise<void>(resolve => { release = resolve; });
      if (state === 'error') return { data: null, error: { status: 503, value: {
        status: 503, type: 'about:blank', code: 'read_unavailable', title: 'Inventory unavailable',
      } } };
      const items = state === 'empty' ? [] : inventory.page.items.filter(item => item.id === ids.recipe);
      return { data: { ...inventory.page, items, count: { ...inventory.page.count, value: items.length } }, error: null };
    } } }) } } } as unknown as MainClient;
    void readInventory(agent.iri, {}, undefined, main).then(answer => { if (mounted) setLoaded(answer); });
    return () => { mounted = false; release?.(); };
  }, [state]);
  return <StudioFrame agent={agent} agents={[agent]} session={agent} path="" locale="en" messages={messages}>
    {loaded ? <StudioHome agent={agent} content={{ view: 'all', works: loaded }} moreHref={null} now={now} locale="en" messages={messages} />
      : <StudioHomePending label="Loading…" />}
  </StudioFrame>;
}
const meta = { title: 'Studio/Recipe contract visit', component: RecipeStudio, args: { state: 'populated' },
  globals: { viewport: { value: 'desktop' } }, parameters: { recipeProveStates,
    docs: { description: { component: 'Unrecorded contract inventory. Runs readInventory with a typed client and renders the production Studio identity frame and home. Recording gap: GET /v1/me/agents/{agent}/works?limit=20&view=authored.' } } },
} satisfies Meta<typeof RecipeStudio>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const } } };
export const OwnRecipe: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('link', { name: 'Ginger lemon tea' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Continue writing' })).toHaveAttribute('href',
    localizedPath(editingHref(agent, ids.recipe, 'recipe', { language: 'en' }), 'en'));
  await expect(canvas.getByRole('region', { name: 'Writing as' })).toHaveTextContent(agent.label!);
} };
export const OwnRecipePhone: Story = { ...OwnRecipe, ...phone };
export const Empty: Story = { args: { state: 'empty' } };
export const EmptyPhone: Story = { ...Empty, ...phone };
export const Unavailable: Story = { args: { state: 'error' }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByRole('alert')).toBeVisible();
} };
export const UnavailablePhone: Story = { ...Unavailable, ...phone };
export const Loading: Story = { args: { state: 'loading' }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByRole('status')).toHaveAttribute('aria-busy', 'true');
} };
export const LoadingPhone: Story = { ...Loading, ...phone };
