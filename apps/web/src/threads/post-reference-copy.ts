export type PostReferenceClipboard = Readonly<{
  writeText: (text: string) => Promise<void>;
}>;

export type PostReferenceCopyResult = 'success' | 'denied' | 'unavailable';

function isPermissionDenied(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotAllowedError';
}

/** One explicit write of the captured admitted destination; no reads, retries or optimistic success. */
export async function copyPostReferenceDestination(
  destination: string,
  clipboard?: PostReferenceClipboard,
): Promise<PostReferenceCopyResult> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'unavailable';
  try {
    await clipboard.writeText(destination);
    return 'success';
  } catch (error) {
    return isPermissionDenied(error) ? 'denied' : 'unavailable';
  }
}
