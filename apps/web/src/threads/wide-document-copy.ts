import { extractSelectedCode, type WideDocumentDescriptor } from './wide-document-reading';

export type ClipboardPort = Readonly<{ writeText: (value: string) => Promise<void> }>;

export type WideDocumentCopyState =
  | Readonly<{ blockOrder: number; status: 'pending' }>
  | Readonly<{ blockOrder: number; status: 'copied' }>
  | Readonly<{ blockOrder: number; status: 'failed' | 'unavailable'; text: string }>;

/** Read the browser clipboard once; unsupported or denied access remains a visible recovery state. */
export function currentClipboard(): ClipboardPort | undefined {
  try {
    if (typeof navigator === 'undefined') return undefined;
    const clipboard = navigator.clipboard;
    return clipboard && typeof clipboard.writeText === 'function' ? clipboard : undefined;
  } catch {
    return undefined;
  }
}

export function selectedCodeForCopy(descriptor: WideDocumentDescriptor): string {
  return extractSelectedCode(descriptor);
}

/** Never retries. The caller reports success only for the promise that completed in its current visit. */
export function writeCodeToClipboard(
  text: string,
  clipboard: ClipboardPort | undefined,
): Promise<'copied' | 'failed' | 'unavailable'> {
  if (!clipboard) {
    text = '';
    return Promise.resolve('unavailable');
  }
  let pending: Promise<void>;
  try {
    pending = clipboard.writeText(text);
  } catch {
    text = '';
    return Promise.resolve('failed');
  }
  // The system clipboard owns any in-flight copy; this helper keeps no second text reference.
  text = '';
  return pending.then(
    () => 'copied' as const,
    () => 'failed' as const,
  );
}
