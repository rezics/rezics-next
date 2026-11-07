import type { Release } from '@rezics/definitions/contract';

type SubjectIdentity = { type: string; release: string };
type CatalogueMetadata = {
  state: 'released' | 'unsupported' | 'unavailable';
  type: string;
  digest?: string;
  definitions?: Pick<Release, 'types' | 'properties'>;
};

/** Pass only the definitions pinned to this Subject's exact released read. */
export function subjectCatalogueTagDefinitions(
  subject: SubjectIdentity,
  catalogue: CatalogueMetadata | undefined,
): Pick<Release, 'types' | 'properties'> | undefined {
  if (
    catalogue?.state !== 'released' ||
    catalogue.type !== subject.type ||
    !catalogue.digest ||
    catalogue.digest !== subject.release ||
    !catalogue.definitions
  )
    return;
  return catalogue.definitions;
}
