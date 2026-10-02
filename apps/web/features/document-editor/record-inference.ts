import { BFF_PREFIX } from '../api/browser.ts';
import { classifyImage } from './image-inference.ts';

/** Persist both successful predictions and unavailable client observations for exact uploaded bytes. */
export async function recordImageInference(input: { image: Blob; sha256: string; representation: string;
  actingSubject: string; key: string }, send: typeof fetch = fetch): Promise<void> {
  const inference = await classifyImage(input.image, input.sha256);
  const response = await send(`${BFF_PREFIX}/v1/media/representations/${input.representation}/inferences`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:inference` },
    body: JSON.stringify({ actingSubject: input.actingSubject, sha256: input.sha256, ...inference }),
  });
  if (!response.ok) throw new Error('image-inference-not-recorded');
}
