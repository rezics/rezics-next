import { createHash } from 'node:crypto';
import type { ContentCore, VariantIdentity } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { saveAdmittedContentDraft } from '../content-publication/draft.ts';

export interface CatalogDescriptionInput {
  resourceId: string;
  language: { kind: 'tag'; tag: string; originalTag: string };
  direction: VariantIdentity['direction'];
  expectedHead: string | null;
  description: string;
  actingSubject: string;
  idempotencyKey: string;
}

/** Stable, language-specific Content slot for an Organization description. */
export function catalogDescriptionVariantId(resourceId: string, language: string): string {
  const hex = createHash('sha256').update(`catalog-description-v1\0${resourceId}\0${language}`)
    .digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `urn:rezics:variant:${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * One resource type probe, scoped Content admission, and one Content CAS save;
 * no roster, descendant, or organization-control traversal is performed.
 */
export function patchCatalogDescription(env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: CatalogDescriptionInput) {
  const variantId = catalogDescriptionVariantId(input.resourceId, input.language.tag);
  return saveAdmittedContentDraft(env, content, account, access, request, {
    resourceId: input.resourceId,
    targetProfile: 'catalog-description',
    variant: { id: variantId, resourceId: input.resourceId,
      language: input.language, direction: input.direction },
    expectedHead: input.expectedHead,
    body: input.description,
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey,
  });
}
