import { parseTransferRequest, type TransferRequest } from './operator-transfer';

export const TRANSFER_FILE_BYTES = 4096;
export type HandoffKind = 'request' | 'acceptance';
export type HandoffError = 'one-file' | 'too-large' | 'unreadable' | 'invalid-request' | 'invalid-acceptance';
type HandoffFile = Pick<File, 'size' | 'arrayBuffer'>;
type HandoffResult =
  | { kind: 'request'; text: string; request: TransferRequest }
  | { kind: 'acceptance'; text: string }
  | { kind: 'failure'; reason: HandoffError };

/** Local transport only. No identity, authorization or approval comes from a file. */
export async function readTransferHandoff(files: ArrayLike<HandoffFile>, kind: HandoffKind): Promise<HandoffResult> {
  if (files.length !== 1 || !files[0]) return { kind: 'failure', reason: 'one-file' };
  const file = files[0];
  if (file.size > TRANSFER_FILE_BYTES) return { kind: 'failure', reason: 'too-large' };
  let text: string;
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > TRANSFER_FILE_BYTES) return { kind: 'failure', reason: 'too-large' };
    // Preserve a BOM if present, and refuse invalid UTF-8 rather than replacing bytes.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: 'failure', reason: 'unreadable' };
  }
  const request = parseTransferRequest(text);
  if (kind === 'request') return request ? { kind, text, request } : { kind: 'failure', reason: 'invalid-request' };
  // Same closed opaque-reference validity as operator-transfer.ts. Do not trim,
  // parse, normalize or shorten a reference. A recognized request is the wrong file.
  return !request && text.length > 0 && text.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(text)
    ? { kind, text }
    : { kind: 'failure', reason: 'invalid-acceptance' };
}

/** The original closed request JSON or the original plain-text reference only. */
export function downloadTransferHandoff(kind: HandoffKind, text: string): boolean {
  // Blob would replace lone surrogates. Refuse a lossy download instead.
  if (!text.isWellFormed()) return false;
  let url: string | undefined;
  let link: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([text], { type: kind === 'request' ? 'application/json' : 'text/plain' }));
    link = document.createElement('a');
    link.href = url;
    link.download = kind === 'request' ? 'operator-transfer-request.json' : 'operator-transfer-acceptance.txt';
    document.body.appendChild(link);
    link.click();
    return true;
  } catch {
    return false;
  } finally {
    link?.remove();
    if (url) {
      const temporaryUrl = url;
      setTimeout(() => URL.revokeObjectURL(temporaryUrl), 0);
    }
  }
}
