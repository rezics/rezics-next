export {
  appearanceAgeProperty,
  appearanceProperty,
  characterWorkIdentityOverlay,
  characterWorkType,
  copyWorkDisclosureOverlay,
  copyWorkProperty,
  identityProperty,
  pageViewerActions,
  quotationPageDocuments,
  quotationTypeAdmitted,
  recipePageDocuments,
  recipeTypeAdmitted,
  semanticPageView,
  spoilerProperty,
  type CharacterWorkIdentityOverlay,
  type CopyWorkDisclosureOverlay,
  type PageViewer,
  type PageViewerActions,
  type PublicSemanticPageMetadata,
  type SemanticPageOverlay,
} from './page-application.ts';
import { presentationApplication } from './page-application.ts';
import type { PageDocumentRead } from '@rezics/composition';
import type { PageDocumentRelease } from './page-contract.ts';

/** Nested configured-page document overlay uses the constructed Presentation application. */
export function characterPageDocuments(
  base: PageDocumentRead | null,
  release: PageDocumentRelease | undefined,
  type: string | null,
  subject: string | null,
  available: readonly string[],
  context?: string,
) {
  return presentationApplication().characterPageDocuments(base, release, type, subject, available, context);
}

/** Nested Semantic page-metadata uses the constructed Presentation application. */
export async function preparePublicSemanticPageMetadata(
  ...args: Parameters<ReturnType<typeof presentationApplication>['preparePublicSemanticPageMetadata']>
) {
  return presentationApplication().preparePublicSemanticPageMetadata(...args);
}

export async function readQuotationPageAuthority(
  ...args: Parameters<ReturnType<typeof presentationApplication>['readQuotationPageAuthority']>
) {
  return presentationApplication().readQuotationPageAuthority(...args);
}

export async function readPeopleProducerPageAuthority(
  ...args: Parameters<ReturnType<typeof presentationApplication>['readPeopleProducerPageAuthority']>
) {
  return presentationApplication().readPeopleProducerPageAuthority(...args);
}
