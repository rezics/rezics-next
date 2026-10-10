import type { MainClient } from '../discover/types.ts';

/** A private Realm lists threads only for a member, so the first post is read as `actor`. */
export async function readSetupFirstPost(
  main: MainClient,
  realm: string,
  actor: string,
): Promise<boolean> {
  const result = await main.v1.realms({ realm: realm.slice(-36) }).threads.get({
    query: { sort: 'new', limit: 1, actingSubject: actor },
  });
  return Boolean(result.data?.items.length);
}
