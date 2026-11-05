import { describe, expect, test } from 'bun:test';
import { ConsolidationReview } from '../src/library/label-consolidation/review';
import type { ReviewPage, SelectedAssignment } from '../src/library/label-consolidation/client';

const selected = (n: number): SelectedAssignment[] =>
  Array.from({ length: n }, (_, i) => ({
    subjectId: `retained-subject-${i}`,
    assignmentId: `assignment-${i}`,
    revision: 3,
  }));
function page(items: SelectedAssignment[], next: string | null = null): ReviewPage {
  return {
    selection: 'advisory',
    sourceLabel: { id: 'source', revision: 2, name: 'Source' },
    targetLabel: { id: 'target', revision: 4, name: 'Target' },
    next,
    items: items.map((item) => ({
      selected: item,
      source: { id: item.assignmentId, revision: 3, effective: true },
      target: null,
      outcome: 'movable',
    })),
  };
}

describe('selected native consolidation review', () => {
  test('explicit bounded pages retain all original identities and require every page', () => {
    const items = selected(5);
    const review = new ConsolidationReview('source', 'target', items);
    items[0]!.revision = 99;
    const first = review.request(() => true);
    expect(first.body.items[0]!.revision).toBe(3);
    expect(first.accept(page(selected(4), 'next'))).toBe(true);
    expect(review.confirmation()).toBeNull();
    const last = review.request(() => true);
    expect(last.body.items).toEqual(selected(5));
    expect(last.body).toMatchObject({ limit: 4, cursor: 'next' });
    expect(last.accept(page(selected(5).slice(4)))).toBe(true);
    const confirmation = review.confirmation()!;
    expect(confirmation.items).toHaveLength(5);
    expect(confirmation.items[0]!.target).toBeNull();
    confirmation.items[0]!.selected.revision = 99;
    expect(review.confirmation()!.items[0]!.selected.revision).toBe(3);
  });

  test.each(['changed', 'missing', 'inaccessible', 'capacity_limited'] as const)(
    '%s cannot shrink the confirmed selection',
    (outcome) => {
      const review = new ConsolidationReview('source', 'target', selected(1));
      const value = page(selected(1));
      value.items[0]!.outcome = outcome;
      if (outcome === 'inaccessible') value.items[0]!.source = null;
      expect(review.request(() => true).accept(value)).toBe(true);
      expect(review.confirmation()).toBeNull();
    },
  );

  test('late pages and retired reader evidence are rejected', () => {
    const review = new ConsolidationReview('source', 'target', selected(1));
    let current = true;
    const pending = review.request(() => current);
    current = false;
    expect(pending.accept(page(selected(1)))).toBe(false);
    review.retire();
    expect(review.evidence).toEqual([]);
    expect(review.total).toBe(0);
    expect(() => review.request(() => true)).toThrow();
  });

  test('renamed target, mismatched identities and oversized pages invalidate the visit', () => {
    for (const change of [
      (value: ReviewPage) => {
        value.targetLabel.revision++;
      },
      (value: ReviewPage) => {
        value.items[0]!.selected.assignmentId = 'recreated';
      },
      (value: ReviewPage) => {
        value.selection = 'x'.repeat(17000);
      },
    ]) {
      const review = new ConsolidationReview('source', 'target', selected(5));
      review.request(() => true).accept(page(selected(4), 'next'));
      const value = page(selected(5).slice(4));
      change(value);
      expect(review.request(() => true).accept(value)).toBe(false);
      expect(review.confirmation()).toBeNull();
      expect(review.evidence).toEqual([]);
    }
  });
});
