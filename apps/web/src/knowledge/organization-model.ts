import type { KnowledgeBreadcrumb, KnowledgeNavigationFrontier } from './navigation-model';
import type { KnowledgePlacementRow } from './navigation-read';
import type { OrganizationIntent, OrganizationOperations, OrganizationPage, OrganizationReceipt, OrganizationRequest } from './organization-read';

export type OrganizationFrontier = Readonly<{
  request: OrganizationRequest;
  breadcrumbs: readonly KnowledgeBreadcrumb[];
  structureRevisionId?: string | undefined;
}>;
export type OrganizationSource = Readonly<{
  row: KnowledgePlacementRow;
  frontier: OrganizationFrontier;
  structureRevisionId: string;
}>;
export type OrganizationReview = Readonly<{
  source: OrganizationSource;
  destination: string;
  before: string | null;
  intent: OrganizationIntent;
}>;
export type OrganizationSnapshot = Readonly<{
  state: 'preparing' | 'ready' | 'changed' | 'unavailable' | 'denied' | 'signed-out' | 'retired';
  frontier: OrganizationFrontier;
  page?: OrganizationPage | undefined;
  source?: OrganizationSource | undefined;
  review?: OrganizationReview | undefined;
  previous?: OrganizationReview | undefined;
  receipt?: OrganizationReceipt | undefined;
  command: 'idle' | 'preparing' | 'review' | 'sending' | 'uncertain' | 'conflict' | 'rejected' | 'unavailable' | 'acknowledged';
}>;

/** A single replacing page, a selected source, and at most one sealed command. No reconstructed tree. */
export class KnowledgeOrganizationReading {
  private snapshot: OrganizationSnapshot;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private retired = false;
  private currentFrontier: OrganizationFrontier;
  constructor(private operations: OrganizationOperations, frontier: KnowledgeNavigationFrontier, expired = false, private current = () => true) {
    const request = frontier.request;
    if (request.kind !== 'outline') throw new Error('Organization requires an outline');
    this.currentFrontier = { ...frontier, request };
    this.snapshot = { state: expired ? 'changed' : 'preparing', frontier: this.currentFrontier, command: 'idle' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: OrganizationSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private active(snapshot = this.snapshot) { return !this.retired && this.current() && snapshot === this.snapshot; }
  private locked() { return this.snapshot.command !== 'idle' && this.snapshot.command !== 'acknowledged'; }
  async open(frontier = this.snapshot.frontier) {
    if (!this.active()) return;
    const sequence = ++this.sequence;
    const previous = this.snapshot;
    this.publish({ ...previous, state: 'preparing', page: undefined, frontier });
    const result = await this.operations.read(frontier.request);
    if (!this.active() || sequence !== this.sequence) return;
    if (result.state !== 'ready') {
      this.publish({ ...this.snapshot, state: result.state });
      return;
    }
    const page = result.page;
    if (page.kind === 'outline' && frontier.structureRevisionId !== undefined && frontier.structureRevisionId !== page.structureRevisionId) {
      this.publish({ ...this.snapshot, state: 'changed' });
      return;
    }
    const observed = { ...frontier, ...(page.kind === 'history' ? {} : { structureRevisionId: page.structureRevisionId }) };
    if (page.kind === 'outline' && !previous.source) this.currentFrontier = observed;
    this.publish({ ...this.snapshot, state: 'ready', frontier: observed, page });
  }
  private async review(before: KnowledgePlacementRow | null, rootLabel: string) {
    const snapshot = this.snapshot;
    if (!this.active(snapshot) || snapshot.state !== 'ready' || snapshot.page?.kind !== 'outline' || !snapshot.source || this.locked()) return;
    const source = snapshot.source;
    const page = snapshot.page;
    this.publish({ ...snapshot, command: 'preparing' });
    const pending = this.snapshot;
    const prepared = await this.operations.prepare();
    if (!this.active(pending)) return;
    if (prepared.state !== 'ready') {
      this.publish({ ...this.snapshot, state: prepared.state, command: 'idle', source: undefined, review: undefined });
      return;
    }
    const intent: OrganizationIntent = Object.freeze({
      notebookId: page.notebookId,
      placementId: source.row.placementId,
      expectedStructureRevisionId: page.structureRevisionId,
      destinationParentPlacementId: page.parentPlacementId,
      beforePlacementId: before?.placementId ?? null,
      idempotencyKey: crypto.randomUUID(),
      binding: Object.freeze({ ...prepared.binding }),
    });
    this.publish({ ...this.snapshot, command: 'review', review: Object.freeze({ source, destination: snapshot.frontier.breadcrumbs.at(-1)?.title ?? rootLabel, before: before?.title ?? null, intent }) });
  }
  private async send(snapshot: OrganizationSnapshot) {
    if (!this.active(snapshot) || !snapshot.review || (snapshot.command !== 'review' && snapshot.command !== 'uncertain')) return;
    const review = snapshot.review;
    this.publish({ ...snapshot, command: 'sending', page: undefined });
    const pending = this.snapshot;
    const result = await this.operations.move(review.intent);
    if (!this.active(pending)) return;
    if (result.state === 'acknowledged') {
      this.publish({ ...this.snapshot, command: 'acknowledged', receipt: Object.freeze({ ...result.receipt }), source: undefined });
    } else if (result.state === 'signed-out' || result.state === 'retired' || result.state === 'denied') {
      this.publish({ state: result.state, frontier: this.currentFrontier, command: 'idle' });
    } else {
      this.publish({ ...this.snapshot, command: result.state });
    }
  }
  actions(snapshot: OrganizationSnapshot, rootLabel = '') {
    const active = () => this.active(snapshot);
    const browse = () => active() && !this.locked() && snapshot.command !== 'acknowledged';
    const outline = () => snapshot.state === 'ready' && snapshot.page?.kind !== 'history' ? snapshot.page : undefined;
    const restart = (frontier: OrganizationFrontier) => {
      const { cursor: _, ...request } = frontier.request;
      return { request, breadcrumbs: frontier.breadcrumbs };
    };
    return {
      more: () => { if (browse() && snapshot.state === 'ready' && snapshot.page?.next) void this.open({ ...snapshot.frontier, request: { ...snapshot.frontier.request, cursor: snapshot.page.next } }); },
      retry: () => { if (browse() && snapshot.state === 'unavailable') void this.open(snapshot.frontier); },
      restart: () => {
        if (!active() || snapshot.command === 'sending' || snapshot.command === 'uncertain') return;
        this.publish({ ...snapshot, command: 'idle', previous: snapshot.review ?? snapshot.previous, source: undefined, review: undefined });
        void this.open(restart(snapshot.source?.frontier ?? snapshot.frontier));
      },
      root: () => {
        if (!browse()) return;
        const request = snapshot.frontier.request;
        if (request.kind === 'history') return;
        void this.open({ request: { ...request, parentPlacementId: null, cursor: undefined }, breadcrumbs: [], ...(snapshot.source ? { structureRevisionId: snapshot.source.structureRevisionId } : {}) });
      },
      ancestor: (index: number) => {
        if (!browse() || !outline()) return;
        const request = snapshot.frontier.request;
        if (request.kind === 'history') return;
        const breadcrumbs = snapshot.frontier.breadcrumbs.slice(0, index + 1);
        void this.open({ ...snapshot.frontier, request: { ...request, parentPlacementId: breadcrumbs.at(-1)!.placementId, cursor: undefined }, breadcrumbs });
      },
      children: (row: KnowledgePlacementRow) => {
        const page = outline();
        if (!browse() || !page || snapshot.frontier.breadcrumbs.length >= 32 || !page.placements.includes(row)) return;
        const request = snapshot.frontier.request;
        if (request.kind === 'history') return;
        void this.open({ ...snapshot.frontier, request: { ...request, parentPlacementId: row.placementId, cursor: undefined }, breadcrumbs: [...snapshot.frontier.breadcrumbs, { placementId: row.placementId, title: row.title }] });
      },
      source: (row: KnowledgePlacementRow) => {
        const page = outline();
        if (!browse() || page?.kind !== 'outline' || !page.placements.includes(row)) return;
        const source = Object.freeze({ row: Object.freeze({ ...row }), frontier: snapshot.frontier, structureRevisionId: page.structureRevisionId });
        this.publish({ ...snapshot, source, previous: undefined, receipt: undefined, review: undefined, command: 'idle' });
      },
      review: (before: KnowledgePlacementRow | null) => {
        const page = outline();
        if (!browse() || page?.kind !== 'outline' || (before && !page.placements.includes(before))) return;
        void this.review(before, rootLabel);
      },
      confirm: () => { void this.send(snapshot); },
      cancel: () => {
        if (!active() || snapshot.command === 'sending' || snapshot.command === 'uncertain') return;
        this.publish({ ...snapshot, source: undefined, review: undefined, previous: undefined, command: 'idle' });
        void this.open(restart(this.currentFrontier));
      },
      history: () => {
        if (!browse()) return;
        this.publish({ ...snapshot, source: undefined, review: undefined, previous: undefined });
        void this.open({ request: { kind: 'history', notebookId: snapshot.frontier.request.notebookId }, breadcrumbs: [] });
      },
      historical: (revisionId: string) => {
        if (!browse() || snapshot.state !== 'ready' || snapshot.page?.kind !== 'history' || !snapshot.page.revisions.some((row) => row.structureRevisionId === revisionId && row.historyAvailable)) return;
        void this.open({ request: { kind: 'historical', notebookId: snapshot.page.notebookId, revisionId, parentPlacementId: null }, breadcrumbs: [] });
      },
      current: (root = false) => {
        if (!active() || this.locked()) return;
        const parent = snapshot.review?.intent.destinationParentPlacementId;
        const frontier = snapshot.review && snapshot.command === 'acknowledged'
          ? { request: { kind: 'outline' as const, notebookId: snapshot.review.intent.notebookId, parentPlacementId: parent ?? null }, breadcrumbs: snapshot.frontier.breadcrumbs }
          : restart(this.currentFrontier);
        this.publish({ ...snapshot, source: undefined, review: undefined, previous: undefined, command: 'idle' });
        void this.open(root ? { request: { kind: 'outline', notebookId: frontier.request.notebookId, parentPlacementId: null }, breadcrumbs: [] } : frontier);
      },
    };
  }
  retire() {
    this.retired = true;
    this.sequence++;
    this.publish({ state: 'retired', frontier: { request: { kind: 'outline', notebookId: '', parentPlacementId: null }, breadcrumbs: [] }, command: 'idle' });
    this.listeners.clear();
    this.operations = { read: async () => ({ state: 'retired' }), prepare: async () => ({ state: 'retired' }), move: async () => ({ state: 'retired' }) };
  }
}
