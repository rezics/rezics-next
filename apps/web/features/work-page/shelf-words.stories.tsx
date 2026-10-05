import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { memoryReaderActions, storyWorkId } from '../catalogue/fixtures.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { RatingLine } from './ratings.tsx';
import { shelfWords } from './shelf-words.ts';
import { WorkKindActions } from './types/actions.tsx';

type Kind = Parameters<typeof shelfWords>[0];
const kinds = {
  game: { kind: 'plain', presentation: 'game', primaryAction: 'visit' },
  software: { kind: 'plain', presentation: 'default', primaryAction: 'install' },
  recipe: { kind: 'recipe', presentation: 'recipe', primaryAction: 'read' },
  skill: { kind: 'skill', presentation: 'skill', primaryAction: 'install' },
  prompt: { kind: 'prompt', presentation: 'prompt', primaryAction: 'copy' },
  media: { kind: 'plain', presentation: 'media', primaryAction: 'read' },
} as const satisfies Record<string, Kind>;

function Actions({ experience, signedIn }: { experience: keyof typeof kinds; signedIn: boolean }) {
  const t = messages.en;
  const kind = kinds[experience];
  return (
    <ReaderActionsProvider
      signedIn={signedIn}
      signInHref="/auth/start"
      actions={signedIn ? memoryReaderActions() : undefined}
    >
      <div className="grid w-64 gap-3 p-6">
        <WorkKindActions
          kind={kind.kind}
          workId={storyWorkId(1)}
          title="Work"
          locale="en"
          messages={t}
          hubText="Text"
          words={shelfWords(kind, t)}
        />
      </div>
    </ReaderActionsProvider>
  );
}

const meta = {
  title: 'Work page/Shelf words',
  component: Actions,
  args: { experience: 'game', signedIn: true },
  parameters: { route: { pathname: localizedPath(resourceHref('/w/', fixture.workRef), 'en') } },
} satisfies Meta<typeof Actions>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A Work's shelf action names its kind's verb, not reading, while the stored statuses stay the same three. */
export const Game: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Want to read')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Want to play' }));
    await expect(await canvas.findByRole('button', { name: /^Want to play — Shelve/ })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Want to play — Shelve/ }));
    await expect(await within(document.body).findByRole('menuitemradio', { name: 'Playing' })).toBeVisible();
    await expect(within(document.body).getByRole('menuitemradio', { name: 'Played' })).toBeVisible();
  },
};
export const Software: Story = {
  args: { experience: 'software' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Want to use' })).toBeVisible();
  },
};
export const Recipe: Story = {
  args: { experience: 'recipe' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Want to cook' })).toBeVisible();
  },
};
export const Skill: Story = {
  args: { experience: 'skill' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Want to use' })).toBeVisible();
  },
};
export const Prompt: Story = {
  args: { experience: 'prompt' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Want to use' })).toBeVisible();
  },
};
/** A Work with no verb of its own keeps the reading words. */
export const Media: Story = {
  args: { experience: 'media' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Want to read' })).toBeVisible();
  },
};
export const SignedOutGame: Story = {
  args: { signedIn: false },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: /Want to play/ })).toBeVisible();
  },
};

function Counts({ experience }: { experience: keyof typeof kinds }) {
  return (
    <div className="p-6">
      <RatingLine ratings={fixture.globalRatings} stats={fixture.workStats} experience={kinds[experience]} locale="en" messages={messages.en} />
    </div>
  );
}
/** The count of people on the shelf names the Work's own verb: playing, using, cooking, reading. */
export const ReadingNowWords: Story = {
  render: (args) => <Counts experience={args.experience} />,
  args: { experience: 'game' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('38 people are currently playing')).toBeVisible();
    await expect(canvas.queryByText(/currently reading/)).toBeNull();
  },
};
export const UsingNowWords: Story = {
  render: (args) => <Counts experience={args.experience} />,
  args: { experience: 'software' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('38 people are currently using')).toBeVisible();
  },
};
export const CookingNowWords: Story = {
  render: (args) => <Counts experience={args.experience} />,
  args: { experience: 'recipe' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('38 people are currently cooking')).toBeVisible();
  },
};
export const ReadingNowKeepsBookWords: Story = {
  render: (args) => <Counts experience={args.experience} />,
  args: { experience: 'media' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('38 people are currently reading')).toBeVisible();
  },
};
