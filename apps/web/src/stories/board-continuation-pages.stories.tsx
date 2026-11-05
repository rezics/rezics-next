import type { Meta } from '@storybook/react-vite';
import { ContinueHot as continuation } from './board-continuation.stories';

const meta = { title: 'Pages/Community/Board Continuation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
export const ContinueHot = { ...continuation };
