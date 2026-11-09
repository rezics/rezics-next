/**
 * Reuse the owner's admitted initial observation exactly once per requested identity.
 * Every subsequent read goes to that same live owner. In particular, a retained
 * primary batch must never answer its own final currentness check.
 *
 * Cost: one set entry per admitted key (at most 200 for discovery, 160 for primary
 * membership). No additional reads: this forwards the existing revalidation reads
 * instead of satisfying them from a request-local snapshot.
 */
export function createCurrentSourceReader<Snapshot>(
  ports: Readonly<{
    initial(partition: number, ids: readonly string[]): Snapshot;
    current(partition: number, ids: readonly string[]): Promise<Snapshot>;
  }>,
): (partition: number, ids: readonly string[]) => Promise<Snapshot> {
  const observed = new Set<string>();
  return async (partition, ids) => {
    const current = ids.some((id) => observed.has(id));
    for (const id of ids) observed.add(id);
    return current ? ports.current(partition, ids) : ports.initial(partition, ids);
  };
}
