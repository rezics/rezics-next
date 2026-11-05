import { createHash, randomUUID } from 'node:crypto';
import type { KernelClient } from '@rezics/client';
import type { ShowcaseJournal } from './showcase-publication.ts';

type VndbSurface = KernelClient['libraryImports']['vndb'];
type Preview = NonNullable<Awaited<ReturnType<VndbSurface['$preview']['post']>>['data']>;

export type ShowcasePersonalListUpload =
  | { state: 'uploaded'; uploadId: string; rows: number }
  | { state: 'refused'; code: string }
  | { state: 'unknown-delivery'; code: string };

function preview(value: unknown): Pick<Preview, 'uploadId' | 'rows'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return (
    typeof result.uploadId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.uploadId) &&
    Number.isSafeInteger(result.rows) &&
    Number(result.rows) >= 0
  )
    ? { uploadId: result.uploadId, rows: Number(result.rows) }
    : null;
}

/** Uploads one private export through the signed-in person's generated Kernel client. */
export async function seedShowcasePersonalList(input: {
  client: KernelClient;
  journal: ShowcaseJournal;
  xml: string;
}): Promise<ShowcasePersonalListUpload> {
  const digest = createHash('sha256').update(input.xml, 'utf8').digest('hex');
  const actionKey = `personal-list:vndb:upload:${digest}`;
  const sealed = input.journal.prepareAction(actionKey, { xml: input.xml }, randomUUID()) as { xml: string };
  const action = input.journal.action(actionKey)!;
  const route = input.client.libraryImports.vndb;
  if (typeof route !== 'function') throw new TypeError('Kernel client does not expose VNDB imports');

  let response: Awaited<ReturnType<VndbSurface['$preview']['post']>>;
  try {
    response = await route.$preview.post(
      { xml: sealed.xml },
      { headers: { 'idempotency-key': JSON.stringify(action.idempotency_key) } },
    );
  } catch (error) {
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException) &&
      !(error instanceof SyntaxError)
    )
      throw error;
    return { state: 'unknown-delivery', code: 'transport-unavailable' };
  }

  if (response.error) {
    const code = `http-${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      input.journal.refuseAction(actionKey, code);
      return { state: 'refused', code };
    }
    return { state: 'unknown-delivery', code };
  }

  const uploaded = preview(response.data);
  if (!uploaded) return { state: 'unknown-delivery', code: 'invalid-response' };
  input.journal.acknowledgeAction(actionKey, uploaded.uploadId);
  return { state: 'uploaded', ...uploaded };
}
