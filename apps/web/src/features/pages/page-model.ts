import type { TermsPageAuthority } from './semantic-render-port';
import type { SelectedContext, PageContinuation } from '@rezics/composition';
import type { Release, ReleasedRelationDirectionResult } from '@rezics/definitions';
import type { NativePageBody } from './page-read-failure';
import type { SubjectStreams } from './subject-streams';
import type { SubjectCommunity } from './subject-community';
import type { PageDocument } from './render';

export type SubjectPageData = {
  /** Optional current Terms operation advice, independent of public names and subject-level actions. */
  termsAuthority?: TermsPageAuthority;
  /** The subject the page is for; an agent page always has one, a route page none. */
  subject: string | null;
  /** The account an agent page is for, as the page read named it. */
  account?: { id: string; handle: string };
  context?: SelectedContext | undefined;
  /** The requested selector survives a native Global fallback without inventing Realm metadata. */
  requestedRealm?: string | undefined;
  /** Exact supplied Board operand; it selects Subject-thread entry and grants nothing. */
  board?: string | undefined;
  /** Requested Board operand retained for reader-cache identity; it grants nothing. */
  requestedBoard?: string | undefined;
  /** BFF cache identity of this reading; never native read authority. */
  requestedReader?: string | null | undefined;
  continuation?: PageContinuation | undefined;
  streams?: SubjectStreams | undefined;
  community?: SubjectCommunity;
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: PageDocument;
  /** The views the subject's templates define; absent when the kernel did not say. */
  views?: string[];
  /** Bounded active file/group vocabulary carried by the native page response. */
  catalogue?: {
    state: 'released' | 'unsupported' | 'unavailable';
    type: string;
    digest?: string;
    definitions?: Pick<Release, 'types' | 'properties'>;
    directions?: ReleasedRelationDirectionResult[];
  };
  /** Caller-bound native action state; page responses containing it are private and no-store. */
  viewer?: NativePageBody['viewer'];
  /** Native Access envelope for the selected subject; private and no-store with viewer. */
  actions?: NativePageBody['actions'];
  reads: Record<string, { status: number; body: unknown; retryAt?: number; headers?: Record<string, string> }>;
};

/** The context the page's reads are planned in. */
export function pageContext(page: Pick<SubjectPageData, 'subject' | 'account' | 'context' | 'continuation' | 'board'>) {
  return {
    subject: page.subject,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(page.board ? { board: page.board } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  };
}
