import type {
  PageContinuation,
  PageDocumentRead,
  PresentationProfile,
  ResolvedTemplate,
  SelectedContext,
  View,
} from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { Actor } from '../request/access.ts';
import type { SessionComponent } from '../tokens/session.ts';

/** Well-known Global Context id; page reads authorize this resource for presentation:read. */
export const PAGE_GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';

export type PageViewer = { kind: 'anonymous' } | { kind: 'account' };
export type PageActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'absent' | 'withheld';
export type PageAction = { action: string; operationId: string; state: PageActionState };
export type PeopleProducerActionState = PageActionState;

export type PageAccount = { id: string; handle: string; automated: boolean; operatorId: string | null };
export type PageTarget = ({ subject: string; realm?: string; board?: string } | { route: string } | { account: string }) & {
  view?: View;
};

export type PageReadResult = { status: number; body: unknown; headers?: Record<string, string> };

export type SemanticPageOverlay = {
  unavailable: { id: string; admitted: false }[];
  meanings: Record<string, { text: string; lang: string | null }>;
};
export type CharacterWorkUnavailableId = 'age-at-appearance' | 'main-character-linkage' | 'character-relationship';
export type CopyWorkUnavailableId = 'copy-work-disclosure';
export type CharacterWorkIdentityOverlay = SemanticPageOverlay & {
  unavailable: { id: CharacterWorkUnavailableId; admitted: false }[];
};
export type CopyWorkDisclosureOverlay = SemanticPageOverlay & {
  unavailable: { id: CopyWorkUnavailableId; admitted: false }[];
};

export type PageViewerActions =
  | { status: 'ready'; viewerActions: { action: string; operations: string[] }[] }
  | { status: 'withheld' }
  | { status: 'unavailable' }
  | { status: 'denied' };

export type PublicSemanticPageMetadata = {
  views: readonly string[];
  /** An Account association vetoes independent Subject fallback; it never proves an Account target. */
  independentSubject: boolean;
};

export type SelectedPageSnapshot = {
  context: SelectedContext;
  realm: { realmId: string; contextId: string; headRevisionId: string; title: string };
  publication: { publicationId: string } | null;
  subject: string;
};

export type PageWireResult = {
  status: number;
  body: unknown;
  session: string | null;
  retryAfter?: string;
  /** Agent-address replacement; HTTP writes Location from the current request. */
  redirectAccount?: { handle: string; view?: View };
};

export type PageSession = {
  ring: import('../tokens/seal.ts').KeyRing;
  scope: string;
};

export type PageExecution = {
  pool: import('pg').Pool;
  routeKey: Uint8Array;
  access: import('../request/access.ts').Access;
  tokens: import('../tokens/seal.ts').KeyRing;
  clock: () => Date;
  deadlineNow: () => number;
  dispatch: (request: Request) => Promise<Response>;
  actor: Actor;
  deadline: number;
  request: Request;
  run<T>(work: () => Promise<T>): Promise<T>;
  record(component: SessionComponent): void;
  sessionComponents(): SessionComponent[];
  admit(client: import('pg').PoolClient): Promise<boolean>;
  draftPreview: boolean;
  capturedProfile?: PresentationProfile;
  /** Draft preview admits the curator and the anonymous public reader. */
  draftReaders?: readonly Actor[];
  includeEligibility: boolean;
};

export type ConfiguredPageRequest = {
  execution: PageExecution;
  target: PageTarget;
  languages?: readonly string[];
  continuation?: PageContinuation;
  stream?: string;
};

export type PageProfileRead = {
  digest: string;
  head?: number;
  profile: PresentationProfile;
};

export type PageDocumentRelease = {
  types?: Record<string, { bases?: readonly string[]; properties?: readonly string[] }>;
  properties?: Record<string, { datatype?: string }>;
};

export type PageReleaseSlice = Pick<Release, 'types' | 'properties'>;
export type PagePropertyDefinition = PropertyDefinition;
export type PageResolvedTemplate = ResolvedTemplate;
export type PageSelectedContext = SelectedContext;
export type PageView = View;
export type PageDocumentPlan = PageDocumentRead;
export type PagePresentationProfile = PresentationProfile;
