import type { KnowledgeNavigationFrontier, KnowledgeNavigationReader } from './navigation-model';
import type { KnowledgeNavigationPage, KnowledgeNavigationRequest, KnowledgePlacementRow } from './navigation-read';

type OutlineRequest = Extract<KnowledgeNavigationRequest, { kind: 'outline' }>;
export type KnowledgeOutlineRow = Readonly<{
  placement: KnowledgePlacementRow;
  /** The exact page supplying this placement, even after this branch has appended more pages. */
  frontier: KnowledgeNavigationFrontier;
}>;
export type KnowledgeOutlineBranch = Readonly<{
  state: 'preparing' | 'ready' | 'unavailable' | 'changed' | 'denied' | 'signed-out' | 'retired';
  frontier: KnowledgeNavigationFrontier & { request: OutlineRequest };
  rows: readonly KnowledgeOutlineRow[];
  next: string | null;
  expanded: boolean;
}>;
export type KnowledgeOutlineSnapshot = Readonly<{
  root: string | null;
  branches: ReadonlyMap<string | null, KnowledgeOutlineBranch>;
}>;

/** Explicitly revealed native pages. Branch requests never replace a sibling or the document canvas. */
export class KnowledgeOutlineReading {
  private snapshot: KnowledgeOutlineSnapshot;
  private listeners = new Set<() => void>();
  private pending = new Map<string | null, object>();
  private retired = false;
  private structureRevisionId: string | undefined;
  constructor(
    private read: KnowledgeNavigationReader,
    frontier: KnowledgeNavigationFrontier,
    expired = false,
    private current = () => true,
  ) {
    const request = frontier.request as OutlineRequest;
    this.structureRevisionId = frontier.structureRevisionId;
    const root = request.parentPlacementId;
    this.snapshot = {
      root,
      branches: new Map([
        [
          root,
          {
            state: expired ? 'changed' : 'preparing',
            frontier: { ...frontier, request },
            rows: [],
            next: null,
            expanded: true,
          },
        ],
      ]),
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(branches: ReadonlyMap<string | null, KnowledgeOutlineBranch>) {
    this.snapshot = { ...this.snapshot, branches };
    for (const listener of this.listeners) listener();
  }
  private replace(parent: string | null, branch: KnowledgeOutlineBranch) {
    const branches = new Map(this.snapshot.branches);
    branches.set(parent, branch);
    this.publish(branches);
  }
  private active(parent: string | null, branch: KnowledgeOutlineBranch) {
    return !this.retired && this.current() && this.snapshot.branches.get(parent) === branch;
  }
  private conceal(state: 'changed' | 'denied' | 'signed-out' | 'retired') {
    this.pending.clear();
    const root = this.snapshot.branches.get(this.snapshot.root)!;
    this.publish(new Map([[this.snapshot.root, { ...root, state, rows: [], next: null }]]));
  }
  async open(parent = this.snapshot.root) {
    const branch = this.snapshot.branches.get(parent)!;
    if (!this.active(parent, branch)) return;
    const token = {};
    this.pending.set(parent, token);
    this.replace(parent, { ...branch, state: 'preparing' });
    const result = await this.read(branch.frontier.request);
    if (this.retired || !this.current() || this.pending.get(parent) !== token) return;
    this.pending.delete(parent);
    if (result.state === 'denied' || result.state === 'signed-out' || result.state === 'retired') {
      this.conceal(result.state);
      return;
    }
    if (result.state === 'changed') {
      this.conceal('changed');
      return;
    }
    // A disclosure can collapse while its deliberately requested page is in flight.
    const latest = this.snapshot.branches.get(parent)!;
    if (result.state !== 'ready') {
      this.replace(parent, { ...latest, state: result.state });
      return;
    }
    const page = result.page as Extract<KnowledgeNavigationPage, { kind: 'outline' }>;
    if (this.structureRevisionId !== undefined && this.structureRevisionId !== page.structureRevisionId) {
      this.conceal('changed');
      return;
    }
    this.structureRevisionId = page.structureRevisionId;
    const frontier = { ...latest.frontier, structureRevisionId: page.structureRevisionId };
    this.replace(parent, {
      ...latest,
      state: 'ready',
      frontier,
      rows: [...latest.rows, ...page.placements.map((placement) => ({ placement, frontier }))],
      next: page.next,
    });
  }
  actions(parent: string | null, branch: KnowledgeOutlineBranch) {
    const active = () => this.active(parent, branch);
    return {
      more: () => {
        if (!active() || branch.state !== 'ready' || !branch.next) return;
        this.replace(parent, {
          ...branch,
          frontier: { ...branch.frontier, request: { ...branch.frontier.request, cursor: branch.next } },
        });
        void this.open(parent);
      },
      retry: () => {
        if (active() && branch.state === 'unavailable') void this.open(parent);
      },
      restart: () => {
        if (!active()) return;
        this.pending.clear();
        this.structureRevisionId = undefined;
        const { cursor: _, ...request } = branch.frontier.request;
        const root = this.snapshot.root;
        this.publish(
          new Map([
            [
              root,
              {
                state: 'preparing',
                frontier: { request, breadcrumbs: branch.frontier.breadcrumbs },
                rows: [],
                next: null,
                expanded: true,
              },
            ],
          ]),
        );
        void this.open(root);
      },
      toggle: (row: KnowledgePlacementRow) => {
        if (!active()) return;
        const child = this.snapshot.branches.get(row.placementId);
        if (child) {
          this.replace(row.placementId, { ...child, expanded: !child.expanded });
          return;
        }
        this.replace(row.placementId, {
          state: 'preparing',
          frontier: {
            request: {
              kind: 'outline',
              notebookId: branch.frontier.request.notebookId,
              parentPlacementId: row.placementId,
            },
            breadcrumbs: [...branch.frontier.breadcrumbs, { placementId: row.placementId, title: row.title }],
            structureRevisionId: branch.frontier.structureRevisionId!,
          },
          rows: [],
          next: null,
          expanded: true,
        });
        void this.open(row.placementId);
      },
    };
  }
  remember(parent: string | null, branch: KnowledgeOutlineBranch, row: KnowledgeOutlineRow) {
    return this.active(parent, branch) ? row.frontier : undefined;
  }
  invalidate() {
    if (!this.retired && this.current()) this.conceal('changed');
  }
  retire() {
    this.retired = true;
    this.conceal('retired');
    this.listeners.clear();
    this.read = async () => ({ state: 'retired' });
  }
}
