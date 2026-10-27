import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = { title: 'Probe/Unnamed control', render: () => <button type="button" /> } satisfies Meta;
export default meta;
export const UnnamedControl: StoryObj<typeof meta> = {};
