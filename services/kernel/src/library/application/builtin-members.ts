import type { BuiltinMemberCapability, BuiltinMemberOptions, LibraryActor } from '../contract/index.ts';

/** A directory miss is never empty proof; only native truth can admit an empty first page. */
export function createBuiltinMembersApplication<View, Query, Member>(
  native: BuiltinMemberCapability<View, Query, Member>,
) {
  return async (actor: LibraryActor, id: string, options: BuiltinMemberOptions<Query> = {}) => {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw native.invalidRequest();
    const deadline = options.deadline ?? native.deadline();
    const source = await native.read(actor, id, deadline);
    if (!source) throw native.notFound();
    const empty = await native.proveEmpty(actor, source, deadline);
    if (empty && options.cursor == null) return { members: [], next: null };
    if (actor.kind !== 'account') throw native.notFound();
    return native.readPage(actor, id, {
      ...options,
      limit,
      deadline,
      async revalidateOwner() {
        if (!(await native.read(actor, id, deadline))) throw native.notFound();
      },
      readSourceVersion: () => native.sourceVersion(actor, source, deadline),
    });
  };
}
