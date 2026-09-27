import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SignaturePad } from './signature-pad.tsx';

const meta = {
  title: 'UI/SignaturePad',
  component: SignaturePad,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a signature pad only when a REZICS workflow needs a member-drawn mark, such as acknowledging a moderation handoff; provide a clear action and a typed alternative where the signature has meaning.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={
          context.name === 'Dark Mode'
            ? 'dark aura-canvas min-h-screen bg-background p-6'
            : 'aura-canvas min-h-screen bg-background p-6'
        }
      >
        <div className="mx-auto w-full max-w-xl pt-8">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof SignaturePad>;

export default meta;
type Story = StoryObj<typeof meta>;

const Signature = ({ dark = false, disabled = false }: { dark?: boolean; disabled?: boolean }) => (
  <div className={dark ? 'dark rounded-2xl bg-background p-5 text-foreground' : 'p-5'}>
    <p className="mb-2 font-medium text-foreground">Moderator acknowledgement</p>
    <SignaturePad
      defaultPaths={['M 20 80 C 40 24, 78 24, 108 74']}
      disabled={disabled}
      id="moderation-signature"
      translations={{
        clearTrigger: 'Clear signature',
        control: 'Moderator acknowledgement signature',
      }}
    />
    <p className="mt-2 text-sm text-muted-foreground">
      Draw a signature, or record your name in the moderation note.
    </p>
  </div>
);

export const Acknowledgement: Story = {
  render: () => <Signature />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const clear = canvas.getByRole('button', { name: 'Clear signature' });
    await expect(clear).toBeEnabled();
    await userEvent.click(clear);
    await expect(canvasElement.querySelector('[data-part="segment"] path')).not.toBeInTheDocument();
  },
};

export const Disabled: Story = { render: () => <Signature disabled /> };
export const DarkMode: Story = { render: () => <Signature dark /> };
