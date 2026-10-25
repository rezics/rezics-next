import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { QrCode, QrCodeDownload, QrCodeFrame } from './qr-code.tsx';

const meta = {
  title: 'UI/QrCode',
  component: QrCode,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a QR code in REZICS to help members open a public Work or Realm on another device; include the destination in nearby text and keep the code itself high contrast.',
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
} satisfies Meta<typeof QrCode>;

export default meta;
type Story = StoryObj<typeof meta>;

const RealmCode = ({ dark = false }: { dark?: boolean }) => (
  <div className={dark ? 'rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
    <figure className="grid justify-items-center gap-3">
      <QrCode
        data-testid="science-fiction-realm-code"
        value="https://rezics.com/realms/science-fiction"
      >
        <div aria-label="QR code for the Science Fiction Realm" role="img">
          <QrCodeFrame />
        </div>
        <QrCodeDownload
          className="text-sm text-primary underline underline-offset-4"
          fileName="science-fiction-realm.svg"
          mimeType="image/svg+xml"
        >
          Download QR code
        </QrCodeDownload>
      </QrCode>
      <figcaption className="text-center">
        <p className="font-medium text-foreground">Science Fiction Realm</p>
        <p className="text-sm text-muted-foreground">rezics.com/realms/science-fiction</p>
      </figcaption>
    </figure>
  </div>
);

export const RealmLink: Story = {
  render: () => <RealmCode />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('img', { name: 'QR code for the Science Fiction Realm' }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Download QR code' })).toBeEnabled();
  },
};

export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <RealmCode dark /> };
