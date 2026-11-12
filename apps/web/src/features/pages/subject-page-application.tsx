import type { ReactNode } from 'react';
import type {
  AlbumCurrentVisitReturnProps,
  CharacterAssociationBridgeProps,
  GameClassificationReturn,
  MangaPublicOrigin,
  RecipeCurrentReturn,
  RecipeCurrentReturnInput,
  RecipeCurrentReturnState,
  RecipeCurrentVisitReturnProps,
  RecipeOccurrence,
  SemanticRenderPort,
  WorkTagReadingProps,
} from './semantic-render-port';

let renderPort: SemanticRenderPort | undefined;

/** Install the concrete catalogue binding once at the Subject page composition boundary. */
export function installSemanticRenderPort(port: SemanticRenderPort): void {
  renderPort = port;
}

export function semanticRenderPort(): SemanticRenderPort {
  if (!renderPort) throw new Error('Subject page Semantic render port is not installed');
  return renderPort;
}

export function gameClassificationDescriptor(address: string): GameClassificationReturn | undefined {
  if (!address) return;
  return semanticRenderPort().navigation.gameClassificationReturn(new URL(address, 'https://rezics.invalid').hash);
}

export function consumeGameClassificationReceipt(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  address: string,
  descriptor: GameClassificationReturn | undefined,
): boolean {
  const navigation = semanticRenderPort().navigation;
  if (!address || !descriptor) {
    if (address) storage.removeItem(navigation.gameClassificationReturnStorageKey);
    return false;
  }
  return navigation.consumeGameClassificationReturn(storage, address);
}

export function mangaObservedOrigin(origin: MangaPublicOrigin): MangaPublicOrigin {
  return semanticRenderPort().frames.mangaObservedOrigin(origin);
}

export function conceptPublicReturnHref(
  base: string,
  subject: string,
  locale: string,
  context: string,
  realm?: string,
): string | undefined {
  return semanticRenderPort().frames.conceptPublicReturnHref(base, subject, locale, context, realm);
}

export function storyArcPublicOrigin(input: {
  currentHref?: string;
  id: string;
  locale: string;
  realm?: string;
}): string | undefined {
  return semanticRenderPort().subjects.storyArcPublicOrigin(input);
}

export function renderWorkTagReading(props: WorkTagReadingProps): ReactNode {
  return semanticRenderPort().components.workTagReading(props);
}

export function RecipeCurrentVisitReturn(props: RecipeCurrentVisitReturnProps): ReactNode {
  return semanticRenderPort().components.recipeCurrentVisitReturn(props);
}

export function AlbumCurrentVisitReturn(props: AlbumCurrentVisitReturnProps): ReactNode {
  return semanticRenderPort().components.albumCurrentVisitReturn(props);
}

export function CharacterAssociationBridge(props: CharacterAssociationBridgeProps): ReactNode {
  return semanticRenderPort().components.characterAssociationBridge(props);
}

export function parseRecipeCurrentReturn(href: string, locale: string): RecipeCurrentReturnInput {
  return semanticRenderPort().subjects.parseRecipeCurrentReturn(href, locale);
}

export function recipeCurrentReturnState(
  intent: RecipeCurrentReturn,
  observation:
    | {
        subject: { id: string; type: string };
        context: string;
        realm?: string;
        occurrences: readonly RecipeOccurrence[];
      }
    | undefined,
): RecipeCurrentReturnState {
  return semanticRenderPort().subjects.recipeCurrentReturnState(intent, observation);
}

export function recipePublicSubjectHref(
  subject: { id: string; label: string },
  locale: string,
  context: { context: string; realm?: string },
  returnTo?: string,
): string | undefined {
  return semanticRenderPort().subjects.recipePublicSubjectHref(subject, locale, context, returnTo);
}

export function recipeCorrectionHref(
  subject: { id: string; label: string },
  locale: string,
  visit: { context: string; realm?: string; returnHref?: string },
): string {
  return semanticRenderPort().subjects.recipeCorrectionHref(subject, locale, visit);
}

export function albumCurrentVisitSourceAddress(value: string): string {
  return semanticRenderPort().subjects.albumCurrentVisitSourceAddress(value);
}

export function createAlbumCurrentVisitLink(
  href: string,
  input: unknown,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): { href: string; token: string } {
  return semanticRenderPort().subjects.createAlbumCurrentVisitLink(href, input, locale, validateAddress);
}

export {
  connectionReturnGroup,
  connectionReturnHref,
  connectionReturnWindow,
  connectionWindowFragment,
  organizationHistoryVisitReturn,
  organizationHistoryVisitReturnFragment,
  personBiographyReturn,
  personBiographyReturnFragment,
  subjectCommunityVisitReturn,
  subjectRouteSearchLimit,
  subjectVisitReturn,
  subjectVisitReturnHref,
  summaryReadingFragment,
  summaryReadingReturn,
  withSubjectVisitReturn,
  workCastVisitReturn,
  workCastVisitReturnFragment,
  workFranchiseRestartHref,
  workFranchiseReturnHref,
  workTagOriginatingReturn,
  workTagReturn,
  workTagReturnFragment,
  workTagReturnHref,
  zoneVisitReturn,
} from './subject-visit-return';
export type {
  ConnectionReturnWindow,
  OrganizationHistoryVisitReturn,
  PersonBiographyReturn,
  SummaryReadingReturn,
  WorkCastVisitReturn,
  WorkTagReturn,
} from './subject-visit-return';
