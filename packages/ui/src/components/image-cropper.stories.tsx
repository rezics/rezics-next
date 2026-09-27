import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ImageCropper, ImageCropperImage, ImageCropperSelection } from './image-cropper.tsx';

const coverArt =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#263d5a"/><stop offset="1" stop-color="#6aa3a0"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="470" cy="90" r="48" fill="#f4d79c"/><path d="M0 290 170 150l120 115 116-95 234 190H0Z" fill="#1d2b38"/><text x="28" y="320" fill="#fff" font-family="sans-serif" font-size="28">Realm field notes</text></svg>',
  );

const meta = {
  title: 'UI/ImageCropper',
  component: ImageCropper,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use an image cropper when members add a Work cover or Realm image in REZICS, so they can frame the subject before saving a shared catalogue image.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main className={'aura-canvas min-h-screen bg-background p-6'}>
        <div className="mx-auto max-w-2xl pt-8">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof ImageCropper>;

export default meta;
type Story = StoryObj<typeof meta>;

const Crop = ({
  dark = false,
  cropShape = 'rectangle',
}: {
  dark?: boolean;
  cropShape?: 'rectangle' | 'circle';
}) => (
  <div className={dark ? 'rounded-2xl bg-background p-5 text-foreground' : undefined}>
    <p className="mb-3 font-medium text-foreground">Crop a Realm cover</p>
    <ImageCropper
      aria-label="Crop the Realm cover image"
      aspectRatio={16 / 9}
      cropShape={cropShape}
    >
      <ImageCropperImage
        alt="Stylized mountain landscape titled Realm field notes"
        src={coverArt}
      />
      <ImageCropperSelection />
    </ImageCropper>
    <p className="mt-3 text-sm text-muted-foreground">
      Drag the frame to keep the title and landscape visible in the Realm header.
    </p>
  </div>
);

export const RealmCover: Story = {
  render: () => <Crop />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('group', { name: 'Crop the Realm cover image' }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole('slider', { name: 'Crop selection area (rectangle)' }),
    ).toBeInTheDocument();
  },
};

export const CircularCrop: Story = { render: () => <Crop cropShape="circle" /> };
export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <Crop dark /> };
