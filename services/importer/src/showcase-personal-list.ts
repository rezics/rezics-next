import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { KernelClient } from '@rezics/client';
import type { ShowcaseJournal } from './showcase-publication.ts';

type VndbSurface = KernelClient['libraryImports']['vndb'];
type PreviewResponse = Awaited<ReturnType<VndbSurface['$preview']['post']>>;

export const developmentPersonalListScopes = ['library_entry:update'] as const;
const EXPORT_BYTES = 2 * 1024 * 1024;
const PREVIEW_PATH = '/v1/libraryImports/vndb:preview';

export type ShowcasePersonalListIdentity = {
  origin: string;
  actor: { accountId: string; clientId: string };
  credential: { keyId: string };
};

export type ShowcasePersonalListUpload =
  | { state: 'uploaded'; uploadId: string; rows: number }
  | { state: 'unavailable'; code: string }
  | { state: 'refused'; code: string }
  | { state: 'unknown-delivery'; code: string };

/** External private input only; the native preview owns XML parsing and version admission. */
export async function readShowcasePersonalListExport(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > EXPORT_BYTES)
      throw new TypeError('VNDB export must be a nonempty owner-only regular file of at most 2 MiB');
    const bytes = Buffer.alloc(EXPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > EXPORT_BYTES || length !== info.size) throw new TypeError('VNDB export changed size while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

function preview(value: unknown): { uploadId: string; rows: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return typeof result.uploadId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.uploadId) &&
    Number.isSafeInteger(result.rows) &&
    Number(result.rows) >= 0 &&
    Number(result.rows) <= 5000
    ? { uploadId: result.uploadId, rows: Number(result.rows) }
    : null;
}

/** Uploads one private export through the signed-in person's generated Kernel client. */
export async function seedShowcasePersonalList(input: {
  client: KernelClient;
  journal: ShowcaseJournal;
  xml: string;
  identity: ShowcasePersonalListIdentity;
}): Promise<ShowcasePersonalListUpload> {
  const digest = createHash('sha256').update(input.xml, 'utf8').digest('hex');
  const actionKey = `personal-list:vndb:upload:${digest}`;
  const intent = { ...input.identity, path: PREVIEW_PATH, xml: input.xml };
  const prior = input.journal.action(actionKey);
  const sealed = (
    prior ? JSON.parse(prior.body_json) : input.journal.prepareAction(actionKey, intent, randomUUID())
  ) as typeof intent;
  const action = prior ?? input.journal.action(actionKey)!;
  // The same export in a reused journal must never be sent as a different person or to another destination.
  if (
    sealed.origin !== intent.origin ||
    sealed.path !== intent.path ||
    sealed.actor?.accountId !== intent.actor.accountId ||
    sealed.actor?.clientId !== intent.actor.clientId ||
    sealed.credential?.keyId !== intent.credential.keyId
  )
    return { state: 'unavailable', code: 'sealed-identity-changed' };
  if (action.state === 'refused') return { state: 'refused', code: action.error_code! };

  let response: PreviewResponse;
  try {
    response = await input.client.libraryImports.vndb.$preview.post(
      { xml: sealed.xml },
      { headers: { 'idempotency-key': JSON.stringify(action.idempotency_key) } },
    );
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof SyntaxError))
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

  const uploaded = response.status === 200 ? preview(response.data) : null;
  if (!uploaded) return { state: 'unknown-delivery', code: 'invalid-response' };
  const receiptKey = `${actionKey}:response`;
  const receipt = input.journal.action(receiptKey);
  if (receipt) {
    const original = JSON.parse(receipt.body_json) as typeof uploaded;
    if (original.uploadId !== uploaded.uploadId || original.rows !== uploaded.rows)
      return { state: 'unknown-delivery', code: 'upload-response-changed' };
  } else {
    input.journal.prepareAction(receiptKey, uploaded, action.idempotency_key);
  }
  input.journal.acknowledgeAction(receiptKey, uploaded.uploadId);
  input.journal.acknowledgeAction(actionKey, uploaded.uploadId);
  return { state: 'uploaded', ...uploaded };
}
