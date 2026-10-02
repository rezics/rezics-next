import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { classifyImage, type ClientImageInference } from './image-inference.ts';

function ClientInference() {
  const [result, setResult] = useState<ClientImageInference | null>(null);
  const [busy, setBusy] = useState(false);
  async function classify() {
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = 224; canvas.height = 224;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#b6d2dc'; context.fillRect(0, 0, 224, 224);
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await image.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    setResult(await classifyImage(image, sha256)); setBusy(false);
  }
  return <div className="grid max-w-md gap-3 p-4"><Button disabled={busy} onClick={() => void classify()}>Classify sample image</Button>
    <output aria-label="Classifier status">{busy ? 'Loading model' : result?.status ?? 'Not started'}</output>
    {result ? <output aria-label="Label observation">{result.result}</output> : null}
  </div>;
}
const meta = { title: 'Media/Client inference', component: ClientInference } satisfies Meta<typeof ClientInference>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BundledModel: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Classify sample image' }));
    await waitFor(() => expect(canvas.getByLabelText('Classifier status')).toHaveTextContent('completed'), { timeout: 12_000 });
    await expect(canvas.getByLabelText('Label observation')).toHaveTextContent(/sfw|nsfw/);
  },
};
