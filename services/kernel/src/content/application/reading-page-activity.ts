import {
  ReadingPageChangedError,
  type ReadingPageActivity,
  type ReadingPageActivityPort,
  type ReadingPageActivitySelection,
  type ReadingPagePlace,
} from '../contract/index.ts';

/** One native selection, then confirmation after foreign hydration. No reply-page input supplies a total. */
export async function selectReadingPageActivity<Anchor, Selection extends ReadingPageActivitySelection<Anchor>>(
  producer: ReadingPageActivityPort<Anchor, Selection>,
  place: ReadingPagePlace,
  deadline: number,
) {
  let selected: readonly Selection[];
  const selection = await producer.select([place.threadId], deadline);
  if (selection.state === 'unavailable') {
    return {
      confirm: async (): Promise<{ value: ReadingPageActivity; anchors: readonly Anchor[] }> => ({
        value: { state: 'unavailable', retryable: true },
        anchors: [],
      }),
    };
  }

  selected = selection.value;
  function requirePlace(item: Selection) {
    if (item.threadId !== place.threadId) throw new ReadingPageChangedError();
    if (item.status !== 'current') return;
    const witness = item.witness;
    if (
      witness.threadId !== place.threadId ||
      witness.boardId !== place.boardId ||
      witness.threadSecurityRevision !== place.threadSecurityRevision ||
      witness.boardSecurityRevision !== place.boardSecurityRevision ||
      witness.realmId !== place.realmId
    )
      throw new ReadingPageChangedError();
  }
  if (selected.length !== 1) throw new ReadingPageChangedError();
  requirePlace(selected[0]!);

  return {
    async confirm(): Promise<{ value: ReadingPageActivity; anchors: readonly Anchor[] }> {
      let confirmed: readonly Selection[];
      const confirmation = await producer.confirm(selected, deadline);
      if (confirmation.state === 'unavailable') {
        return { value: { state: 'unavailable', retryable: true }, anchors: [] };
      }
      confirmed = confirmation.value;
      if (confirmed.length !== 1) throw new ReadingPageChangedError();
      const item = confirmed[0]!;
      requirePlace(item);
      // A changed activity observation uses the page's existing same-request retry path.
      if (item.status === 'withheld') {
        if (item.reason === 'stale' || selected[0]!.status === 'current') throw new ReadingPageChangedError();
        return { value: { state: 'withheld' }, anchors: [] };
      }
      return {
        value: {
          state: 'current',
          cohort: item.cohort,
          count: { ...item.replyCount },
          lastActivityAt: item.lastContributionAt,
        },
        anchors: [item.witness.source],
      };
    },
  };
}
