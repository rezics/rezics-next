import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, within } from 'storybook/test';
import { forgetReadingLanguages } from '../content-language/use-reading-languages.ts';
import { PostComposer } from './composer.tsx';
import { postText } from './messages.ts';

const realm = 'https://rezics.com/id/7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const actor = 'https://rezics.com/id/a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';
const draftKey = `rezics:post-draft:${actor}`;

const meta = {
  title: 'Compose/Post',
  component: PostComposer,
  args: {
    locale: 'en',
    actingSubject: actor,
    initial: { id: realm, name: 'Fiction Harbor' },
    target: {
      id: 'https://rezics.com/id/d0e1f2a3-b4c5-4d6e-8f7a-000000000001',
      mainVersion: null,
      revision: 'https://rezics.com/id/d0e1f2a3-b4c5-4d6e-8f7a-000000000002',
      title: 'The last letter',
    },
  },
  render: (args) => (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">{postText.title[args.locale]}</h1>
      <PostComposer {...args} />
    </main>
  ),
  beforeEach({ parameters }) {
    localStorage.removeItem(draftKey);
    forgetReadingLanguages();
    const projectionPending = parameters.postProjection === 'lag';
    const original = window.fetch.bind(window);
    const fetch = spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;
      if (!path.startsWith('/api/main/')) return original(input, init);
      if (path.endsWith('/person-preferences')) return Response.json({ contentLanguages: ['en'] });
      if (path.endsWith('/member-reply-drafts')) {
        if (projectionPending)
          return Response.json({ revisionId: '00000000-0000-4000-8000-000000000003', revisionDigest: 'a'.repeat(64) });
        return Response.json({ code: 'authority_denied' }, { status: 403 });
      }
      if (path.endsWith('/realm-replies') && projectionPending)
        return Response.json({ reply: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004' });
      if (path.endsWith('/realm-reply-placements') && projectionPending) {
        const body = (input instanceof Request
          ? await input.clone().json()
          : JSON.parse(String(init?.body ?? '{}'))) as { reply?: string };
        return Response.json({ reply: body.reply, placement: 'placement' });
      }
      if (path.includes(`/realms/${realm.slice(-36)}/threads/`) && projectionPending)
        return Response.json({ code: 'reply_unavailable' }, { status: 404 });
      if (path.endsWith('/member-ban'))
        return Response.json({
          realm,
          action: 'ban',
          permanent: true,
          bannedUntil: null,
          appeal: { state: 'none' },
        });
      if (path.endsWith(`/realms/${realm.slice(-36)}`))
        return Response.json({ realm, reviewMode: 'open', rules: [] });
      throw new Error(`Unexpected composer request: ${path}`);
    });
    return () => {
      fetch.mockRestore();
      localStorage.removeItem(draftKey);
      forgetReadingLanguages();
    };
  },
} satisfies Meta<typeof PostComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BannedMember: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: postText.titleLabel[args.locale] }),
      'A letter worth discussing',
    );
    await userEvent.type(
      canvas.getByRole('textbox', { name: postText.body[args.locale] }),
      'What did you think of the ending?',
    );
    const body = canvas.getByRole('textbox', { name: postText.body[args.locale] });
    const bodyBeforeBan = body.textContent;
    await userEvent.click(canvas.getByRole('button', { name: postText.post[args.locale] }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(postText.banned[args.locale]);
    await expect(
      canvas.getByRole('textbox', { name: postText.titleLabel[args.locale] }),
    ).toHaveValue('A letter worth discussing');
    const progress = JSON.parse(localStorage.getItem(draftKey)!).progress;
    await expect(progress.restartRequired).toBe(true);
    const title = canvas.getByRole('textbox', { name: postText.titleLabel[args.locale] });
    await expect(title).not.toHaveAttribute('readonly');
    await userEvent.type(title, ' (revised)');
    await expect(title).toHaveValue('A letter worth discussing (revised)');
    await expect(JSON.parse(localStorage.getItem(draftKey)!).progress).toBeNull();
    await expect(body.textContent).toBe(bodyBeforeBan);
  },
};

export const BannedMemberChinese: Story = { ...BannedMember, args: { locale: 'zh-Hans' } };

/** A placement receipt is success even while the new discussion projection catches up. */
export const ProjectionCatchingUp: Story = {
  parameters: { postProjection: 'lag' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: postText.titleLabel[args.locale] }),
      'A letter worth discussing',
    );
    const body = canvas.getByRole('textbox', { name: postText.body[args.locale] });
    await userEvent.type(body, 'What did you think of the ending?');
    await userEvent.click(canvas.getByRole('button', { name: postText.post[args.locale] }));

    await expect(await canvas.findByText(postText.postedAppearing[args.locale])).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: postText.openDiscussion[args.locale] }),
    ).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(
      canvas.getByRole('textbox', { name: postText.titleLabel[args.locale] }),
    ).toHaveValue('');
    await expect(body.textContent).toBe('');
  },
};

export const ProjectionCatchingUpPhoneChinese: Story = {
  ...ProjectionCatchingUp,
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
};
