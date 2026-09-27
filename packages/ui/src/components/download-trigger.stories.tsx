import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DownloadTrigger } from './download-trigger.tsx';

const receipt = JSON.stringify(
  {
    realm: 'Science Fiction',
    works: ['《三体》', 'The Quiet Archive'],
    exportedAt: '2026-09-27',
  },
  null,
  2,
);

const meta = {
  title: 'UI/DownloadTrigger',
  component: DownloadTrigger,
  tags: ['autodocs'],
  args: { data: receipt, fileName: 'science-fiction-realm.json', mimeType: 'application/json' },
  parameters: {
    docs: {
      description: {
        component:
          'Use DownloadTrigger in REZICS when a member or moderator can take a portable copy of a catalogue export, moderation record or other data they are authorized to access.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main
        className={'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'}
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DownloadTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

const ExportAction = ({
  dark = false,
  disabled = false,
}: {
  dark?: boolean;
  disabled?: boolean;
}) => (
  <section
    className={
      dark
        ? 'rounded-2xl bg-background p-6 text-foreground'
        : 'rounded-2xl border border-border/60 bg-card p-6'
    }
  >
    <h2 className="font-semibold text-foreground">Realm catalogue export</h2>
    <p className="my-2 max-w-sm text-sm text-muted-foreground">
      Save a JSON copy of the public Works currently featured in this Realm.
    </p>
    <DownloadTrigger
      className="rounded-xl bg-primary px-4 py-2 font-medium text-primary-foreground text-sm shadow-[var(--aura-shadow-card)] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
      data={receipt}
      disabled={disabled}
      fileName="science-fiction-realm.json"
      mimeType="application/json"
    >
      Download catalogue
    </DownloadTrigger>
  </section>
);

export const JsonExport: Story = {
  render: () => <ExportAction />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const download = canvas.getByRole('button', { name: 'Download catalogue' });
    await expect(download).toBeEnabled();
    await userEvent.click(download);
  },
};

export const Disabled: Story = { render: () => <ExportAction disabled /> };
export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <ExportAction dark /> };
