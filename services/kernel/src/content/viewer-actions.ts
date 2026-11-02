import type { ViewerActionResource, ViewerActionResources } from '../access/viewer-actions.ts';
import { prepareReadDecisions, type AccessClient, type ReadDecisions } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import sources from './viewer-actions.sql';
import containers from './viewer-actions-containers.sql';
import editions from './viewer-actions-edition.sql';

// Native chain() admits the selected post and at most 32 reply ancestors.
// Each of 100 references has one board, thread, Realm, Space, creator and subject.
export const CONTENT_VIEWER_REFERENCE_LIMIT = 100;
export const CONTENT_VIEWER_CHAIN_LIMIT = 33;
export const CONTENT_VIEWER_POST_LIMIT = CONTENT_VIEWER_REFERENCE_LIMIT * CONTENT_VIEWER_CHAIN_LIMIT;
export const CONTENT_VIEWER_POST_PAGES = CONTENT_VIEWER_POST_LIMIT / CONTENT_VIEWER_REFERENCE_LIMIT;
// Access's documented preparation <=6 statements and each formula page <=2.
// One source, container and edition-evidence statement. Subjects may all have
// different released types, requiring at most 100 homogeneous formula pages.
export const CONTENT_VIEWER_SUBJECT_PAGES = CONTENT_VIEWER_REFERENCE_LIMIT;
export const CONTENT_VIEWER_FORMULA_PAGES = CONTENT_VIEWER_POST_PAGES + 4 + CONTENT_VIEWER_SUBJECT_PAGES;
export const CONTENT_VIEWER_STATEMENT_LIMIT = 6 + 3 + 2 * CONTENT_VIEWER_FORMULA_PAGES;

type Kind = 'board' | 'thread' | 'post' | 'edition';
type Source = {
  id: string;
  board_id: string;
  thread_id: string;
  thread_visibility: string;
  creator_id: string | null;
  subject_id: string | null;
  state: string | null;
  posts: { id: string; public: boolean; selected: boolean }[];
};
type Container = {
  id: string;
  public: boolean;
  realm_id: string | null;
  realm_public: boolean | null;
  space_id: string | null;
  unbanned: boolean;
};
type Evidence = { id: string; type: string; public: boolean };
const unique = (ids: readonly string[]) => [...new Set(ids)];
const routes = (ids: readonly string[]) => ids.map((id) => routeOf(id)!);

/** Evaluate captured native rows through the existing formula, in finite pages.
 * No resource-role, author, staff or membership inference supplies permission.
 */
async function allowed(
  decisions: ReadDecisions,
  client: AccessClient,
  time: AuthoritativeTime,
  action: string,
  type: string,
  evidence: readonly Pick<Evidence, 'id' | 'public'>[],
): Promise<Set<string>> {
  const floors = new Map(evidence.map((row) => [row.id, row.public]));
  const ids = [...floors.keys()];
  const result = new Set<string>();
  for (let start = 0; start < ids.length; start += CONTENT_VIEWER_REFERENCE_LIMIT) {
    const page = ids.slice(start, start + CONTENT_VIEWER_REFERENCE_LIMIT);
    const answers = await decisions.decide(
      client,
      {
        action,
        resourceType: type,
        ids: page,
        eligibility: async () => Object.fromEntries(page.map((id) => [id, floors.get(id) === true])),
      },
      time,
    );
    for (const id of page) if (answers[id]?.allowed) result.add(id);
  }
  return result;
}

function resource(kind: Kind): ViewerActionResource {
  const readAction = `${kind}:read`;
  return {
    readAction,
    async read() {
      throw new Error('Content viewer actions require native preparation');
    },
    async prepare({ pool, access, actor, deadline }) {
      // Foreign authority preparation finishes before the endpoint holds its RR client.
      const decisions = await prepareReadDecisions(access, {
        actor,
        actions: new Set(['board:read', 'thread:read', 'post:read', 'realm:read', 'space:read', 'subject:read']),
        context: { pool, deadline },
      });
      return {
        readAction,
        async read(client, ids, at, time) {
          if (!time) throw new Error('Content viewer actions require the shared read time');
          if (ids.length > CONTENT_VIEWER_REFERENCE_LIMIT) throw new RangeError('Too many Content references');
          const input = {
            keys: JSON.stringify(ids.map((id) => ({ route: routeOf(id)!, id }))),
            kind,
            max_posts: CONTENT_VIEWER_CHAIN_LIMIT,
            actor_id: actor.kind === 'account' ? actor.accountId : null,
          };
          const rows =
            kind === 'board'
              ? []
              : (
                  await client.query<Source>(
                    sources.sql,
                    sources.params.map((name) => input[name as keyof typeof input]),
                  )
                ).rows;
          const boards = kind === 'board' ? [...ids] : unique(rows.map((row) => row.board_id));
          const accounts =
            actor.kind === 'account'
              ? unique([
                  actor.accountId,
                  ...(actor.requestedBy?.split(':')[3] ? [actor.requestedBy.split(':')[3]!] : []),
                ])
              : [];
          const containerInput = { routes: routes(boards), ids: boards, accounts, at };
          const parents = (
            await client.query<Container>(
              containers.sql,
              containers.params.map((name) => containerInput[name as keyof typeof containerInput]),
            )
          ).rows;
          const liveParents = parents.filter((row) => row.unbanned);
          const realms = await allowed(
            decisions,
            client,
            time,
            'realm:read',
            'community.realm',
            liveParents.flatMap((row) =>
              row.realm_id ? [{ id: row.realm_id, public: row.realm_public === true }] : [],
            ),
          );
          const readableParents = liveParents.filter((row) => !row.realm_id || realms.has(row.realm_id));
          if (kind === 'board')
            return Object.fromEntries(
              readableParents.map((row) => [row.id, row.public && (!row.realm_id || row.realm_public === true)]),
            );
          const boardAccess = await allowed(decisions, client, time, 'board:read', 'content.board', readableParents);
          const parentMap = new Map(
            readableParents.filter((row) => boardAccess.has(row.id)).map((row) => [row.id, row]),
          );
          const threadAccess = await allowed(
            decisions,
            client,
            time,
            'thread:read',
            'content.thread',
            rows.map((row) => ({ id: row.thread_id, public: row.thread_visibility === 'published' })),
          );
          const postAccess = await allowed(
            decisions,
            client,
            time,
            'post:read',
            'content.post',
            rows.flatMap((row) => row.posts.filter((post) => !(row.state === 'published' && post.selected))),
          );
          let editionEvidence: Evidence[] = [];
          let spaces = new Set<string>();
          const subjects = new Set<string>();
          if (kind === 'edition') {
            const subjectIds = unique(rows.flatMap((row) => (row.subject_id ? [row.subject_id] : [])));
            const creators = unique(rows.flatMap((row) => (row.creator_id ? [row.creator_id] : [])));
            const params = {
              subjects: subjectIds,
              subject_routes: routes(subjectIds),
              creators,
              creator_routes: routes(creators),
            };
            editionEvidence = (
              await client.query<Evidence>(
                editions.sql,
                editions.params.map((name) => params[name as keyof typeof params]),
              )
            ).rows;
            for (const type of new Set(editionEvidence.filter((row) => row.public).map((row) => row.type))) {
              const permitted = await allowed(
                decisions,
                client,
                time,
                'subject:read',
                type,
                editionEvidence.filter((row) => row.public && row.type === type),
              );
              for (const id of permitted) subjects.add(id);
            }
            spaces = await allowed(
              decisions,
              client,
              time,
              'space:read',
              'community.space',
              readableParents.flatMap((row) => (row.space_id ? [{ id: row.space_id, public: true }] : [])),
            );
          }
          const creators = new Set(editionEvidence.filter((row) => !row.public).map((row) => row.id));
          return Object.fromEntries(
            rows.flatMap((row) => {
              const parent = parentMap.get(row.board_id);
              if (
                !parent ||
                !threadAccess.has(row.thread_id) ||
                row.posts.some((post) => !(row.state === 'published' && post.selected) && !postAccess.has(post.id))
              )
                return [];
              if (
                kind === 'edition' &&
                (!creators.has(row.creator_id!) ||
                  !subjects.has(row.subject_id!) ||
                  (parent.space_id && !spaces.has(parent.space_id)))
              )
                return [];
              // Editions have authenticated read authority; draft metadata is available
              // only to its creator under the ordinary source checks above.
              const floor =
                kind !== 'edition' &&
                parent.public &&
                (!parent.realm_id || parent.realm_public === true) &&
                row.thread_visibility === 'published' &&
                row.posts.every((post) => post.public);
              return [[row.id, floor]];
            }),
          );
        },
      };
    },
  };
}

export const contentViewerActionResources: ViewerActionResources = new Map(
  (['board', 'thread', 'post', 'edition'] as const).map((kind) => [`content.${kind}`, resource(kind)]),
);
