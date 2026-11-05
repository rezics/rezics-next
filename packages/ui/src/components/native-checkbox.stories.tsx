import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { NativeCheckbox } from './native-checkbox';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'Components/NativeCheckbox',
  component: NativeCheckbox,
  decorators: [withSurface],
} satisfies Meta<typeof NativeCheckbox>;
export default meta;
type Story = StoryObj<typeof meta>;

function Comparison({ dark = false }: { dark?: boolean }) {
  return (
    <div className={dark ? 'dark' : ''}>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-5 gap-y-4 rounded-xl bg-background p-6 text-foreground">
        <span />
        <strong>NativeCheckbox</strong>
        <strong>shadcn Checkbox</strong>
        <span>Unchecked</span>
        <NativeCheckbox aria-label="Native unchecked" />
        <Checkbox aria-label="Shared unchecked" />
        <span>Checked</span>
        <NativeCheckbox aria-label="Native checked" defaultChecked />
        <Checkbox aria-label="Shared checked" defaultChecked />
        <span>Disabled checked</span>
        <NativeCheckbox aria-label="Native disabled checked" disabled defaultChecked />
        <Checkbox aria-label="Shared disabled checked" disabled defaultChecked />
        <span>Focused</span>
        <NativeCheckbox aria-label="Native focused" autoFocus />
        <Checkbox aria-label="Shared focused" autoFocus />
      </div>
    </div>
  );
}

export const Light: Story = { render: () => <Comparison /> };
export const Dark: Story = { render: () => <Comparison dark /> };
