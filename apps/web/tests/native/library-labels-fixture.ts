import { bundledDigest } from '@rezics/definitions/bundled';
import type { NativeWebStack } from './stack';

/** Create a real subject under the stack's active bundled Definitions release through the native HTTP API. */
export async function createLibraryLabelsSubject(stack: NativeWebStack) {
  const activeResponse = await stack.kernel('/v1/definitions/active');
  if (!activeResponse.ok)
    throw new Error(
      `Bundled Definitions release is unavailable: ${activeResponse.status} ${await activeResponse.text()}`,
    );
  const active = (await activeResponse.json()) as { digest: string };
  if (active.digest !== bundledDigest)
    throw new Error(`Native fixture does not use the bundled Definitions release: ${active.digest}`);

  const title = `Private label work ${crypto.randomUUID().slice(0, 8)}`;
  const created = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: title } }),
    },
    'editor',
  );
  if (!created.ok) throw new Error(`Native subject creation failed: ${created.status} ${await created.text()}`);
  const result = (await created.json()) as { subject: { id: string } };
  return { id: result.subject.id, title };
}
