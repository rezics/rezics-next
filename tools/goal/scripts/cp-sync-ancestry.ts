import { readFastPublicationCheckpoint } from './cp-fast-preserve.ts';

/** Permit ordinary ancestry or the exact, fully verified fast-snapshot checkpoint for the captured heads. */
export function hasCpSyncAncestry(
  checkout: string,
  checkpointFile: string,
  main: string,
  dev: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): boolean {
  if (isAncestor(main, dev)) return true;
  const publication = readFastPublicationCheckpoint(checkout, checkpointFile);
  return publication?.main === main && isAncestor(publication.source, dev);
}
