import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { ReactNode } from 'react';

type Subject = SubjectRead['subject'];
type Related = SubjectRead['related'] & Record<string, SubjectRead['related'][string] & { redirect?: string }>;

/** The page-owned vocabulary for the current Semantic profile and visit capabilities. */
export type SemanticPageComponent<Props extends object> = (props: Props) => ReactNode;

export type WorkTagReadingProps = {
  subject: Subject;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  spoilerThreshold: number;
  currentHref?: string | undefined;
  realm?: string | undefined;
  returnToFor?:
    | ((selection: { property: string; statement: string; spoiler: 0 | 1 | 2; focus: 'browse' | 'evidence' }) => string)
    | undefined;
};

export type RecipeCurrentVisitReturnProps = {
  locale: string;
  address: string;
  intent?: RecipeCurrentReturn;
  state?: RecipeCurrentReturnState;
  invalid?: boolean;
  restartHref?: string;
};

export type AlbumCurrentVisitReturnProps = {
  locale: string;
  current?: AlbumCurrentReading | undefined;
  validateAddress: (value: unknown, locale: string) => string | undefined;
};

export type CharacterAssociationBridgeProps = { source: object; children: ReactNode };

export type GameGroup = 'credits' | 'classification' | 'relations' | 'facts';
export type GameGroups = Record<GameGroup, string[]>;
export type GameClassificationReturn = {
  holder: string;
  property: string;
  statement: string;
  source: string;
  context: string;
  realm?: string;
  type: string;
  locale: string;
  release: string;
  reader: string | null;
  focus: 'keyboard' | 'none';
};
export type CreditReturnLocator = {
  context: string;
  definition: string;
  holder?: string;
  property?: string;
  statement?: string;
  revision?: string;
  release?: string;
  slot?: string;
};
export type WorkFranchiseReturn = {
  stream: string;
  statement?: string;
  holder?: string;
  node?: string;
  focus?: 'browse' | 'evidence';
  release?: string;
  revision?: number;
  spoiler: number;
};
export type MangaOccurrence = {
  node: string;
  direction: 'forward' | 'inverse';
  property: string;
  holder: string;
  statement: string;
  target: string;
};
export type MangaPublicOrigin = {
  subject: string;
  type: 'schema:ComicSeries' | 'schema:PublicationVolume';
  context: string;
  definition?: string;
  realm?: string;
  returnHref?: string;
};
export type AuthoredPublicOrigin = {
  subject: string;
  context: string;
  realm?: string;
  locale: string;
  returnHref: string;
};
export type SubjectTermsViewer = 'signed-in' | 'signed-out' | 'unavailable';
export type TermsPageAuthority = {
  viewer: 'signed-in' | 'signed-out' | 'unavailable';
  actions: { state: 'ready'; actions: { action: string; operations: string[] }[] } | { state: 'unavailable' };
};
export type RecipeOccurrence = { property: string; statement: string; holder: string };
export type RecipeCurrentReturn = {
  recipe: string;
  context: string;
  realm?: string;
  occurrence?: RecipeOccurrence;
  focus: 'keyboard' | 'pointer';
  visit: string;
};
export type RecipeCurrentReturnInput =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: RecipeCurrentReturn };
export type RecipeCurrentReturnState = 'ready' | 'changed' | 'removed' | 'unsupported';
export type AlbumCurrentVisitOrigin = {
  version: 1;
  subject: { id: string; type: 'schema:MusicAlbum'; label: string };
  address: string;
  locale: string;
  context: { id: string; population: 'global' | 'realm'; realm?: string; label?: string };
  release?: string;
  reader?: string;
};
export type AlbumCurrentReading = {
  subjectId: string;
  locale: string;
  context: { id: string; population: 'global' | 'realm'; realm?: string };
  release?: string;
  reader?: string;
  address: string;
};
export type GuideRelease = Pick<Release, 'types' | 'properties'> & { digest: string };

/** Concrete Web adapters implement these capabilities; callers depend only on this page-owned contract. */
export type SemanticRenderPort = {
  components: {
    workTagReading: SemanticPageComponent<WorkTagReadingProps>;
    recipeCurrentVisitReturn: SemanticPageComponent<RecipeCurrentVisitReturnProps>;
    albumCurrentVisitReturn: SemanticPageComponent<AlbumCurrentVisitReturnProps>;
    characterAssociationBridge: SemanticPageComponent<CharacterAssociationBridgeProps>;
  };
  definitions: {
    readGuideRelease(
      client: KernelClient,
      digest?: string,
      headers?: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<GuideRelease>;
    isGuideReadError(error: unknown): boolean;
  };
  frames: {
    mangaObservedOrigin(origin: MangaPublicOrigin): MangaPublicOrigin;
    conceptPublicReturnHref(
      base: string,
      subject: string,
      locale: string,
      context: string,
      realm?: string,
    ): string | undefined;
  };
  subjects: {
    supportsReleasedWorkNames(type: string, release?: Pick<Release, 'types'>): boolean;
    gameReaderEntry(type: string, bases?: readonly string[]): boolean;
    gameGroups(release: Pick<Release, 'types' | 'properties'>, type: string): Record<GameGroup, string[]>;
    gameType(release: Pick<Release, 'types' | 'properties'>, type: string): boolean;
    storyArcPublicOrigin(input: {
      currentHref?: string;
      id: string;
      locale: string;
      realm?: string;
    }): string | undefined;
    readTermsPageAuthority(
      client: KernelClient,
      viewer: SubjectTermsViewer,
      authorization?: string,
      signal?: AbortSignal,
    ): Promise<TermsPageAuthority>;
    parseRecipeCurrentReturn(href: string, locale: string): RecipeCurrentReturnInput;
    recipeCurrentReturnState(
      intent: RecipeCurrentReturn,
      observation:
        | {
            subject: { id: string; type: string };
            context: string;
            realm?: string;
            occurrences: readonly RecipeOccurrence[];
          }
        | undefined,
    ): RecipeCurrentReturnState;
    recipePublicSubjectHref(
      subject: { id: string; label: string },
      locale: string,
      context: { context: string; realm?: string },
      returnTo?: string,
    ): string | undefined;
    recipeCorrectionHref(
      subject: { id: string; label: string },
      locale: string,
      visit: { context: string; realm?: string; returnHref?: string },
    ): string;
    albumCurrentVisitSourceAddress(value: string): string;
    createAlbumCurrentVisitLink(
      href: string,
      input: unknown,
      locale: string,
      validateAddress: (value: unknown, locale: string) => string | undefined,
    ): { href: string; token: string };
  };
  navigation: {
    zoneVisitReturn(value: unknown, locale?: string): string | undefined;
    releaseVisitReturn(value: unknown, locale?: string): string | undefined;
    creditReturn(hash: string): CreditReturnLocator | undefined;
    workFranchiseReturn(hash: string): WorkFranchiseReturn | undefined;
    workFranchiseFragment(value: WorkFranchiseReturn): string;
    mangaOccurrenceFromFragment(fragment: string): MangaOccurrence | undefined;
    gameClassificationReturn(fragment: string): GameClassificationReturn | undefined;
    gameClassificationReturnLimit: number;
    gameClassificationReturnStorageKey: string;
    consumeGameClassificationReturn(storage: Pick<Storage, 'getItem' | 'removeItem'>, address: string): boolean;
  };
};
