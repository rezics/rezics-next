import type {
  KnowledgeNavigationAddress,
  KnowledgeNavigationPage,
  KnowledgeNavigationRequest,
  KnowledgeNavigationResult,
  KnowledgePlacementRow,
} from './navigation-read';

export type KnowledgeBreadcrumb = Readonly<{ placementId: string; title: string }>;
export type KnowledgeNavigationFrontier = Readonly<{
  request: KnowledgeNavigationRequest;
  breadcrumbs: readonly KnowledgeBreadcrumb[];
  structureRevisionId?: string;
}>;
export type KnowledgeNavigationSnapshot = Readonly<{
  state: 'preparing' | 'ready' | 'denied' | 'unavailable' | 'changed' | 'signed-out' | 'retired';
  frontier: KnowledgeNavigationFrontier;
  page?: KnowledgeNavigationPage;
}>;
export type KnowledgeNavigationReader = (request: KnowledgeNavigationRequest) => Promise<KnowledgeNavigationResult>;

/** One active reading. Replacement synchronously releases every row and invalidates old callbacks/results. */
export class KnowledgeNavigationReading {
  private snapshot: KnowledgeNavigationSnapshot;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private retired = false;
  constructor(
    private read: KnowledgeNavigationReader,
    frontier: KnowledgeNavigationFrontier,
    expired = false,
    private current = () => true,
  ) {
    this.snapshot = { state: expired ? 'changed' : 'preparing', frontier };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: KnowledgeNavigationSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  async open(frontier: KnowledgeNavigationFrontier = this.snapshot.frontier) {
    if (this.retired || !this.current()) return;
    const sequence = ++this.sequence;
    this.publish({ state: 'preparing', frontier });
    const result = await this.read(frontier.request);
    if (this.retired || !this.current() || this.sequence !== sequence) return;
    if (result.state !== 'ready') {
      this.publish({ state: result.state, frontier });
      return;
    }
    const page = result.page;
    if (
      page.kind === 'outline' &&
      frontier.structureRevisionId !== undefined &&
      frontier.structureRevisionId !== page.structureRevisionId
    ) {
      this.publish({ state: 'changed', frontier });
      return;
    }
    this.publish({
      state: 'ready',
      page,
      frontier: { ...frontier, ...(page.kind === 'outline' ? { structureRevisionId: page.structureRevisionId } : {}) },
    });
  }
  /** Every action closes over its rendered snapshot; a replaced reading cannot be driven by a stale callback. */
  actions(snapshot: KnowledgeNavigationSnapshot) {
    const current = () => !this.retired && this.current() && this.snapshot === snapshot;
    return {
      retry: () => {
        if (current() && snapshot.state === 'unavailable') void this.open(snapshot.frontier);
      },
      restart: () => {
        if (!current()) return;
        const { cursor: _, ...request } = snapshot.frontier.request;
        void this.open({ request, breadcrumbs: [] });
      },
      more: () => {
        if (current() && snapshot.state === 'ready' && snapshot.page?.next)
          void this.open({
            ...snapshot.frontier,
            request: { ...snapshot.frontier.request, cursor: snapshot.page.next },
          });
      },
      root: () => {
        if (!current() || snapshot.frontier.request.kind !== 'outline') return;
        void this.open({
          request: { kind: 'outline', notebookId: snapshot.frontier.request.notebookId, parentPlacementId: null },
          breadcrumbs: [],
        });
      },
      ancestor: (index: number) => {
        if (!current() || snapshot.frontier.request.kind !== 'outline' || snapshot.state !== 'ready') return;
        const breadcrumbs = snapshot.frontier.breadcrumbs.slice(0, index + 1);
        const parent = breadcrumbs.at(-1)!;
        void this.open({
          ...snapshot.frontier,
          request: {
            kind: 'outline',
            notebookId: snapshot.frontier.request.notebookId,
            parentPlacementId: parent.placementId,
          },
          breadcrumbs,
        });
      },
      children: (row: KnowledgePlacementRow) => {
        if (
          !current() ||
          snapshot.state !== 'ready' ||
          snapshot.page?.kind !== 'outline' ||
          snapshot.frontier.breadcrumbs.length >= 32
        )
          return;
        void this.open({
          request: { kind: 'outline', notebookId: snapshot.page.notebookId, parentPlacementId: row.placementId },
          breadcrumbs: [...snapshot.frontier.breadcrumbs, { placementId: row.placementId, title: row.title }],
          structureRevisionId: snapshot.page.structureRevisionId,
        });
      },
    };
  }
  retire() {
    this.retired = true;
    this.sequence++;
    this.publish({ state: 'retired', frontier: { request: { kind: 'owned' }, breadcrumbs: [] } });
    this.listeners.clear();
    this.read = async () => ({ state: 'retired' });
  }
}

export function knowledgeNavigationRoot(address: KnowledgeNavigationAddress): KnowledgeNavigationFrontier {
  return { request: address, breadcrumbs: [] };
}
