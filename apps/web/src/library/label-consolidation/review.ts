import type { ConfirmationInput, ReviewInput, ReviewPage, SelectedAssignment } from './client';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const exact = (a: SelectedAssignment, b: SelectedAssignment) =>
  a.subjectId === b.subjectId && a.assignmentId === b.assignmentId && a.revision === b.revision;
const sameLabel = (a: ReviewPage['sourceLabel'], b: ReviewPage['sourceLabel']) =>
  a.id === b.id && a.revision === b.revision && a.name === b.name;

/** One visit, one ordered selection. The caller captures current reader/exposure before dispatch. */
export class ConsolidationReview {
  private readonly selection: SelectedAssignment[];
  private pages: ReviewPage[] = [];
  private outstanding: object | null = null;
  private retired = false;
  private readonly cursors = new Set<string>();

  constructor(
    readonly sourceLabelId: string,
    readonly targetLabelId: string,
    items: readonly SelectedAssignment[],
    readonly limit = 4,
  ) {
    if (sourceLabelId === targetLabelId || !items.length || items.length > 16 ||
      !Number.isInteger(limit) || limit < 1 || limit > 4 ||
      new Set(items.map(item => item.subjectId)).size !== items.length ||
      items.some(item => !item.subjectId || !item.assignmentId || !Number.isSafeInteger(item.revision) || item.revision < 1))
      throw new Error('Invalid consolidation selection');
    this.selection = items.map(item => ({ ...item }));
    if (bytes(this.body()) > 8192) throw new Error('Consolidation request exceeds byte limit');
  }

  private body(): ReviewInput {
    const cursor = this.pages.at(-1)?.next;
    return { targetLabelId: this.targetLabelId, items: this.selection.map(item => ({ ...item })), limit: this.limit,
      ...(cursor ? { cursor } : {}) };
  }

  get complete() { return !this.retired && this.pages.length > 0 && this.pages.at(-1)?.next === null; }
  get reviewed() { return this.pages.reduce((count, page) => count + page.items.length, 0); }
  get total() { return this.retired ? 0 : this.selection.length; }
  get evidence(): readonly ReviewPage[] { return structuredClone(this.pages); }

  /** No automatic refill. Invoke once per deliberate request for a bounded page. */
  request(isCurrent: () => boolean) {
    if (this.retired || this.complete || this.outstanding || !isCurrent()) throw new Error('Review is not current');
    const body = this.body();
    if (bytes(body) > 8192) throw new Error('Consolidation request exceeds byte limit');
    const ticket = {};
    this.outstanding = ticket;
    return {
      body,
      accept: (value: ReviewPage) => {
        if (this.retired || this.outstanding !== ticket || !isCurrent()) return false;
        this.outstanding = null;
        const offset = this.reviewed;
        const first = this.pages[0];
        if (bytes(value) > 16384 || value.sourceLabel.id !== this.sourceLabelId || value.targetLabel.id !== this.targetLabelId ||
          value.items.length !== Math.min(this.limit, this.selection.length - offset) ||
          value.items.some((item, index) => !exact(item.selected, this.selection[offset + index]!)) ||
          (first && (value.selection !== first.selection || !sameLabel(value.sourceLabel, first.sourceLabel) || !sameLabel(value.targetLabel, first.targetLabel))) ||
          (value.next !== null && (!value.next || value.next.length > 4096 || this.cursors.has(value.next))) ||
          ((offset + value.items.length === this.selection.length) !== (value.next === null))) {
          // Once evidence disagrees, the whole visit needs a new observation.
          this.retire();
          return false;
        }
        if (value.next) this.cursors.add(value.next);
        this.pages.push(structuredClone(value));
        return true;
      },
      failed: () => { if (this.outstanding === ticket) this.outstanding = null; },
    };
  }

  /** The digest alone never admits confirmation. No non-admissible item is silently dropped. */
  confirmation(): ConfirmationInput | null {
    if (!this.complete || this.outstanding) return null;
    const first = this.pages[0]!;
    const items: ConfirmationInput['items'] = [];
    for (const page of this.pages) for (const item of page.items) {
      if ((item.outcome !== 'movable' && item.outcome !== 'already_on_target') || item.source === null || !item.source.effective)
        return null;
      items.push({ ...item, source: item.source, outcome: item.outcome });
    }
    return structuredClone({ selection: first.selection, sourceLabel: first.sourceLabel, targetLabel: first.targetLabel, items });
  }

  retire() {
    this.retired = true;
    this.outstanding = null;
    this.pages = [];
    this.selection.length = 0;
    this.cursors.clear();
  }
}
