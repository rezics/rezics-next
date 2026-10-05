import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { mainRelationships } from './api.ts';
import { RelationshipControl } from './control.tsx';
import { actor, target } from './fixtures.ts';
import { messages } from './messages.ts';
import type { FollowEdit, FollowState } from './types.ts';
import { chooseMenuItem } from '../stories/choose-option.ts';

type State = 'ready' | 'following' | 'loading' | 'unavailable' | 'signed-out';
let reads: URL[] = [];
let writes: FollowEdit[] = [];

/** Exercise the browser adapter rather than a seam that quietly accepts a guessed kind. */
function ResourceControl({ kind, state }: { kind: string; state: State }) {
  const api = useMemo(() => {
    reads = [];
    writes = [];
    let current: FollowState = { following: state === 'following', revision: state === 'following' ? 'revision-1' : null,
      level: state === 'following' ? 'highlights' : null, source: state === 'following' ? 'explicit' : null, pinPosition: null };
    let revision = 1;
    const transport = (async (input, init) => {
      const url = new URL(String(input), 'https://rezics.test');
      if (init?.method === 'GET') {
        reads.push(url);
        if (state === 'loading') return new Promise<Response>(() => {});
        if (state === 'unavailable') return new Response(null, { status: 503 });
        if (url.searchParams.has('kind')) return new Response(null, { status: 400 });
        return Response.json(current);
      }
      const body = JSON.parse(String(init?.body)) as FollowEdit & { targets?: FollowEdit[] };
      const edit = body.targets?.[0] ?? body;
      writes.push(edit);
      if (edit.kind) return new Response(null, { status: 400 });
      current = { ...current, following: edit.following ?? current.following, level: edit.level ?? current.level ?? 'highlights',
        revision: `revision-${++revision}`, source: 'explicit' };
      const receipt = { ...current, target: target(40), kind: kind.endsWith('/Projection') ? 'projection' : kind };
      return Response.json(body.targets ? { items: [receipt] } : receipt);
    }) as typeof fetch;
    return mainRelationships(actor, { fetch: transport });
  }, [kind, state]);
  return <div className="max-w-lg p-6">
    <RelationshipControl target={target(40)} kind={kind} name="Misaka" locale="en" signedIn={state !== 'signed-out'}
      actingSubject={actor} signInHref="/auth/start" api={api} />
  </div>;
}

const meta = { title: 'Relationships/Resource control', component: ResourceControl,
  args: { kind: 'https://rezics.com/vocab/Character', state: 'ready' },
  async afterEach(context) {
    if (import.meta.env.VITE_CAPTURE_RELATIONSHIPS !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/relationship-review/${context.id}.png` });
  },
} satisfies Meta<typeof ResourceControl>;
export default meta;
type Story = StoryObj<typeof meta>;

const followAndUnfollow: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const follow = await canvas.findByRole('button', { name: 'Follow · Misaka' });
  await waitFor(() => expect(follow).toBeEnabled());
  await userEvent.click(follow);
  for (const level of ['All', 'Off', 'Highlights']) {
    const notifications = await canvas.findByRole('button', { name: /^Notifications:/ });
    await waitFor(() => expect(notifications).toBeEnabled());
    await userEvent.click(notifications);
    await chooseMenuItem(within(document.body), 'menuitemradio', level);
    await expect(await canvas.findByRole('button', { name: `Notifications: ${level}` })).toBeVisible();
  }
  const unfollow = await canvas.findByRole('button', { name: 'Following · Misaka · Unfollow' });
  await waitFor(() => expect(unfollow).toBeEnabled());
  await userEvent.click(unfollow);
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Follow · Misaka' })).toBeEnabled());
  await expect(reads.length).toBeGreaterThan(0);
  await expect(reads.every(url => url.searchParams.get('target') === target(40) && !url.searchParams.has('kind'))).toBe(true);
  await expect(writes.map(edit => [edit.following, edit.level, edit.kind])).toEqual([
    [true, undefined, undefined], [undefined, 'all', undefined], [undefined, 'off', undefined],
    [undefined, 'highlights', undefined], [false, undefined, undefined],
  ]);
  await expect(canvas.queryByText(messages.en.unavailable)).toBeNull();
};

export const Character: Story = { play: followAndUnfollow };
export const Projection: Story = { args: { kind: 'https://rezics.com/vocab/Projection' }, play: followAndUnfollow };
export const Following: Story = { args: { state: 'following' } };
export const Loading: Story = { args: { state: 'loading' } };
export const Unavailable: Story = { args: { state: 'unavailable' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(messages.en.unavailable)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toHaveLength(2));
  } };
export const SignedOut: Story = { args: { state: 'signed-out' } };
