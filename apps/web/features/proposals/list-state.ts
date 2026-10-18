export type ListView = 'mine' | 'review-requested';
export const listViews: readonly ListView[] = ['mine', 'review-requested'];

/** Missing, unknown and repeated query values show the viewer's own proposals. */
export const parseListView = (value: string | string[] | undefined): ListView =>
  value === 'review-requested' ? value : 'mine';

export const listHref = (view: ListView): string =>
  view === 'mine' ? '/proposals' : `/proposals?view=${view}`;
