import type { OrganizationDeletionReader, OrganizationDeletionReview } from './organization-deletion';

export type OrganizationDeletionHistory = 'unsent' | 'unresolved' | 'acknowledged' | 'refused';
export type OrganizationDeletionHistoryView = readonly OrganizationDeletionHistory[];

export type OrganizationDeletionReviewGeneration = OrganizationDeletionReview & {
  selected?: string | undefined;
  operationKey?: string | undefined;
  source?: string | undefined;
  reader?: OrganizationDeletionReader | undefined;
  active: boolean;
  attemptId?: number | undefined;
  onExecutionDispatch: () => boolean;
};

type GenerationInput = {
  selected?: string | undefined;
  operationKey?: string | undefined;
  humanAccountId?: string | undefined;
  source?: string | undefined;
  reader: OrganizationDeletionReader;
};

const order: OrganizationDeletionHistory[] = ['unsent', 'unresolved', 'acknowledged', 'refused'];

/** Page-local generations and generic history; private command identity stays in the attempt descriptor. */
export class OrganizationDeletionReturnController {
  private active: OrganizationDeletionReviewGeneration | null = null;
  private nextAttemptId = 0;
  private readonly attempts = new Map<number, OrganizationDeletionHistory>();
  private readonly settled = new Set<OrganizationDeletionHistory>();

  constructor(
    private readonly publish: (history: OrganizationDeletionHistoryView) => void,
    private readonly dispatched?: () => void,
  ) {}

  get current(): OrganizationDeletionReviewGeneration | null {
    return this.active;
  }

  begin(input: GenerationInput): OrganizationDeletionReviewGeneration {
    this.retire();
    let generation: OrganizationDeletionReviewGeneration;
    generation = {
      ...input,
      active: true,
      isCurrent: () => this.active === generation && generation.active,
      onExecutionDispatch: () => {
        if (!generation.isCurrent() || generation.attemptId === undefined) return false;
        this.attempts.set(generation.attemptId, 'unresolved');
        this.emit();
        this.dispatched?.();
        return true;
      },
    };
    this.active = generation;
    return generation;
  }

  beginAttempt(generation: OrganizationDeletionReviewGeneration): number | null {
    if (!generation.isCurrent()) return null;
    const id = ++this.nextAttemptId;
    generation.attemptId = id;
    this.attempts.set(id, 'unsent');
    this.emit();
    return id;
  }

  seed(history: OrganizationDeletionHistory): void {
    this.settled.add(history);
    this.emit();
  }

  resolveAttempt(id: number | undefined, result: 'acknowledged' | 'refused'): void {
    if (id === undefined || !this.attempts.has(id)) return;
    this.attempts.delete(id);
    this.settled.add(result);
    this.emit();
  }

  finishUnsentAttempt(id: number | undefined): void {
    if (id === undefined || !this.attempts.has(id)) return;
    this.attempts.delete(id);
    this.settled.add('unsent');
    this.emit();
  }

  markAttemptUnresolved(id: number | undefined): void {
    if (id === undefined || !this.attempts.has(id)) return;
    this.attempts.set(id, 'unresolved');
    this.emit();
  }

  attemptPhase(id: number | undefined): OrganizationDeletionHistory | undefined {
    return id === undefined ? undefined : this.attempts.get(id);
  }

  retire(generation = this.active): void {
    if (!generation || this.active !== generation) return;
    generation.active = false;
    generation.selected = undefined;
    generation.humanAccountId = undefined;
    generation.operationKey = undefined;
    generation.source = undefined;
    generation.reader = undefined;
    generation.isCurrent = () => false;
    generation.onExecutionDispatch = () => false;
    this.active = null;
  }

  history(): OrganizationDeletionHistoryView {
    const present = new Set([...this.settled, ...this.attempts.values()]);
    return order.filter((entry) => present.has(entry));
  }

  private emit(): void {
    this.publish(this.history());
  }
}
