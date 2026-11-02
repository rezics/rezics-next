import type { QueryClient } from '@tanstack/react-query';

/** Refresh only the acting viewer's existing private readers after a confirmed write. */
export function refreshFollowing(client: QueryClient, subject: string, removedRow: boolean) {
  // Following already applies its confirmed removal locally, preserving its current
  // cursor and other uncertain row actions. Never walk another page to fill the gap.
  // Target-page controls instead refresh any mounted Following reader.
  const following = { queryKey: ['mine-following', subject] };
  // Cancellation also covers a first read with no data: ordinary invalidation
  // would otherwise let that pre-write response become the visible list.
  void client.cancelQueries(following);
  void client.invalidateQueries({
    ...following,
    refetchType: removedRow ? 'none' : 'active',
  });
  // Counts remain Accounts-authorized native reads. Never increment/decrement a
  // scalar here: canonical support and delayed maintenance can change its meaning.
  const counts = { queryKey: ['library-private-follow-counts', subject] };
  void client.cancelQueries(counts);
  void client.invalidateQueries(counts);
}
