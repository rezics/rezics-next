import type { SelectedContext } from '@rezics/composition';
import { readRealm, type RealmView } from '../community/realm.ts';
import { readPublication, type PublicationHead } from '../community/publication.ts';
import type { SpaceDependencies } from '../community/space.ts';
import type { CommunityAmbient } from '../community/index.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { readContext, publicContextEligibility } from '../semantic/context.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { SessionComponent } from '../tokens/session.ts';

type Authority = {
  deps: SpaceDependencies & CommunityAmbient;
  actor: Actor;
  deadline: number;
  run<T>(work: () => Promise<T>): Promise<T>;
  record(component: SessionComponent): void;
};
export type SelectedPage = {
  context: SelectedContext;
  realm: RealmView;
  publication: PublicationHead | null;
  subject: string;
};
const unavailable = () => new ProblemError('dependency_unavailable', { headers: { 'retry-after': '1' } });

async function contextAuthority(authority: Authority, id: string): Promise<void> {
  const route = routeOf(id);
  if (route === null) throw new ProblemError('not_found');
  const resource = { route, id };
  const check = await accessCheck(
    authority.deps.access,
    authority.actor,
    'context:read',
    { ...resource, eligibility: publicContextEligibility(resource) },
    { pool: authority.deps.pool, deadline: authority.deadline },
  );
  const current = await readContext(authority.deps.pool, id, (client) =>
    check(deadlineClient(client, authority.deadline)),
  );
  if (!current) throw new ProblemError('not_found');
  authority.record(current.component);
}

/** Native owner reads retain denial, ban, deadline and lifecycle semantics. Only a real null publication falls back. */
export async function selectPage(authority: Authority, realmId: string, subject: string): Promise<SelectedPage> {
  return authority.run(async () => {
    const realm = await readRealm(authority.deps, authority.actor, realmId, { deadline: authority.deadline });
    if (!realm) throw new ProblemError('not_found');
    const publication = await readPublication(authority.deps, realmId, subject, {
      actor: authority.actor,
      deadline: authority.deadline,
    });
    const context: SelectedContext =
      publication === null
        ? { id: GLOBAL_CONTEXT, population: { kind: 'global' } }
        : { id: realm.contextId, population: { kind: 'realm', id: realm.realmId, title: realm.title } };
    await contextAuthority(authority, context.id);
    return { context, realm, publication, subject };
  });
}

/** Publication and protected-ban authority can change without changing the Realm head. Discard every old leaf. */
export async function guardSelectedPage(authority: Authority, selected: SelectedPage): Promise<void> {
  await authority.run(async () => {
    const realm = await readRealm(authority.deps, authority.actor, selected.realm.realmId, {
      deadline: authority.deadline,
    });
    if (!realm) throw new ProblemError('not_found');
    const publication = await readPublication(authority.deps, realm.realmId, selected.subject, {
      actor: authority.actor,
      deadline: authority.deadline,
    });
    await contextAuthority(authority, selected.context.id);
    if (
      realm.contextId !== selected.realm.contextId ||
      realm.headRevisionId !== selected.realm.headRevisionId ||
      publication?.publicationId !== selected.publication?.publicationId
    )
      throw unavailable();
  });
}
