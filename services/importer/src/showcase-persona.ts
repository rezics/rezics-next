import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/schema';
import type { AccountTokenProvider } from './credentials.ts';
import type { CrossMediaSeedResult, CrossMediaSelection } from './cross-media-seed.ts';
import { createImportFetch } from './import-fetch.ts';
import { GLOBAL_CONTEXT } from './public-bulk-client.ts';
import { showcaseDigest } from './showcase-manifest.ts';
import type { ShowcaseJournal } from './showcase-publication.ts';

/** Separate creator credential; these are not importer scopes or additional platform grants. */
export const developmentCollectionScopes = [
  'subject:read',
  'collection:create',
  'collection:read',
  'collection:update',
];
export type ShowcaseRequest = (input: {
  path: string;
  audience: 'creator' | 'public';
  body?: unknown;
  key?: string;
}) => Promise<Response>;

export function createDevelopmentShowcaseRequest(options: {
  origin: string;
  token: AccountTokenProvider;
  fetch?: typeof fetch;
}): ShowcaseRequest {
  const upstream = options.fetch ?? fetch;
  const limits = { origin: options.origin, maxBodyBytes: 4096, maxResponseBytes: 262144, deadlineMs: 30000 };
  const creator = createImportFetch({ ...limits, token: options.token, fetch: upstream });
  const publicRead = createImportFetch({
    ...limits,
    token: async () => '',
    fetch: async (input) => {
      const request = new Request(input);
      request.headers.delete('authorization');
      return upstream(request);
    },
  });
  return ({ path, audience, body, key }) =>
    (audience === 'creator' ? creator : publicRead)(new URL(path, options.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const id = Type.String({ format: 'uuid' });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const collectionSchema = Type.Object({
  id,
  curatorAccountId: nullableString,
  presentationKind: nullableString,
  presentationKindSource: Type.Union([Type.Literal('owner'), Type.Literal('mixed')]),
  visibility: Type.String(),
  memberCount: Type.Integer({ minimum: 0 }),
});
const collectionReply = Type.Object({ collection: collectionSchema });
const memberSchema = Type.Object({ id, subjectId: id });
const memberReply = Type.Object({ member: memberSchema });
const membersReply = Type.Object({ members: Type.Array(memberSchema, { maxItems: 100 }), next: nullableString });
const subjectReply = Type.Object({
  subject: Type.Object({
    id,
    type: Type.String(),
    statements: Type.Record(
      Type.String(),
      Type.Array(
        Type.Object({
          value: Type.Object({ type: Type.String(), content: Type.Unknown() }),
        }),
      ),
    ),
  }),
});
const refusedReply = Type.Object({ retryable: Type.Boolean(), effect_status: Type.String() });
type Collection = Static<typeof collectionSchema>;
type Source = { provider: 'bangumi' | 'vndb'; externalId: string; subjectId: string; type: string };
type Failure = {
  status: 'missing-source' | 'refused' | 'unknown-delivery' | 'unavailable' | 'changed';
  code: string;
};
type Outcome<T> = { status: 'current'; value: T } | Failure;
type View = 'ranked' | 'grid' | 'mixed';
export type DevelopmentShowcaseResult = {
  status: 'incomplete';
  collections: ({ view: View; sources: Source[]; id?: string; kind?: string | null } & (
    | Failure
    | { status: 'current'; creator: Collection; public: Collection; members: Static<typeof memberSchema>[] }
  ))[];
  sources: ({ provider: Source['provider']; externalId: string } & Outcome<Source>)[];
  workLinks: CrossMediaSeedResult['workLinks'];
  edition: {
    status: 'producer-unavailable';
    producer: 'seedDevelopmentContentEdition';
    code: 'producer-contract-not-installed';
  };
  offer: { status: 'awaiting-content-edition' };
};

/** Only external HTTP failures become incomplete outcomes; programming errors still throw. */
async function receive<S extends TSchema>(
  request: ShowcaseRequest,
  input: Parameters<ShowcaseRequest>[0],
  schema: S,
): Promise<Outcome<Static<S>>> {
  let response: Response;
  try {
    response = await request(input);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    return { status: input.body === undefined ? 'unavailable' : 'unknown-delivery', code: 'transport-unavailable' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: input.body === undefined ? 'unavailable' : 'unknown-delivery', code: 'invalid-json' };
  }
  if (!response.ok) {
    const explicitRetry = Check(refusedReply, body) && body.retryable && body.effect_status === 'not_applied';
    return {
      status:
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
          ? 'refused'
          : explicitRetry
            ? 'unavailable'
            : response.status >= 500 && input.body !== undefined
              ? 'unknown-delivery'
              : 'unavailable',
      code: `http-${response.status}`,
    };
  }
  // 202 preparation is not an empty member page; an ACK without an ID remains unresolved.
  if (!Check(schema, body))
    return { status: input.body === undefined ? 'unavailable' : 'unknown-delivery', code: 'invalid-response' };
  return { status: 'current', value: body };
}

async function createNative<S extends typeof collectionReply | typeof memberReply>(input: {
  journal: ShowcaseJournal;
  request: ShowcaseRequest;
  action: string;
  path: string;
  body: unknown;
  schema: S;
}): Promise<Outcome<string>> {
  const prior = input.journal.action(input.action);
  if (prior?.state === 'refused') return { status: 'refused', code: prior.error_code! };
  if (prior?.state === 'acknowledged') return { status: 'current', value: prior.result_id! };
  const sealed = input.journal.prepareAction(
    input.action,
    { path: input.path, body: input.body },
    showcaseDigest(input.action),
  ) as {
    path: string;
    body: unknown;
  };
  const operation = input.journal.action(input.action)!;
  const result = await receive(
    input.request,
    {
      audience: 'creator',
      path: sealed.path,
      body: sealed.body,
      key: operation.idempotency_key,
    },
    input.schema,
  );
  if (result.status !== 'current') {
    // Only explicit permanent refusal is terminal. Unknown delivery retains the original body and key.
    if (result.status === 'refused') input.journal.refuseAction(input.action, result.code);
    return result;
  }
  const value = result.value as Static<typeof collectionReply> | Static<typeof memberReply>;
  const resultId = 'collection' in value ? value.collection.id : value.member.id;
  input.journal.acknowledgeAction(input.action, resultId);
  return { status: 'current', value: resultId };
}

export type DevelopmentShowcaseContext = {
  result: Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>;
  selection: CrossMediaSelection;
  journal: ShowcaseJournal;
};

/** Called within the existing CLI's open journal lifetime, after source publication. */
export async function seedDevelopmentShowcase(
  input: DevelopmentShowcaseContext & {
    accountId: string;
    request: ShowcaseRequest;
  },
): Promise<DevelopmentShowcaseResult> {
  const sources: DevelopmentShowcaseResult['sources'] = [];
  const roots = [
    ...input.selection.vndb.map((externalId) => ({ provider: 'vndb' as const, externalId })),
    ...input.selection.bangumi.map((externalId) => ({ provider: 'bangumi' as const, externalId: String(externalId) })),
  ];
  for (const root of roots) {
    const reading = input.result.readings.find(
      (row) => row.source === root.provider && row.externalId === root.externalId,
    );
    if (!reading) {
      sources.push({ ...root, status: 'missing-source', code: 'selected-reading-missing' });
      continue;
    }
    const subjectId = reading.subject.subject!.id!;
    const read = await receive(
      input.request,
      {
        audience: 'public',
        path: `/v1/subjects/${subjectId}?context=${GLOBAL_CONTEXT}`,
      },
      subjectReply,
    );
    if (read.status !== 'current') {
      sources.push({ ...root, ...read });
      continue;
    }
    const subject = read.value.subject;
    const property = root.provider === 'vndb' ? 'wdt:P3180' : 'wdt:P5732';
    if (
      subject.id !== subjectId ||
      subject.type !== reading.subject.subject!.type ||
      !subject.statements[property]?.some((row) => row.value.type === 'value' && row.value.content === root.externalId)
    ) {
      sources.push({ ...root, status: 'missing-source', code: 'current-source-identity-mismatch' });
      continue;
    }
    sources.push({ ...root, status: 'current', value: { ...root, subjectId, type: subject.type } });
  }
  const collections: DevelopmentShowcaseResult['collections'] = [];
  for (const view of ['ranked', 'grid', 'mixed'] as const) {
    const relevant = sources.filter(
      (row) => view === 'mixed' || row.provider === (view === 'ranked' ? 'vndb' : 'bangumi'),
    );
    const current = relevant.flatMap((row) => (row.status === 'current' ? [row.value] : []));
    // No replacement roots: a partial source inventory cannot silently shrink the fixture.
    if (!relevant.length || current.length !== relevant.length) {
      collections.push({ view, sources: current, status: 'missing-source', code: 'selected-source-incomplete' });
      continue;
    }
    const kind = view === 'mixed' || !current.every((row) => row.type === current[0]!.type) ? null : current[0]!.type;
    const action = `persona:${input.accountId}:${view}`;
    const made = await createNative({
      ...input,
      action,
      path: '/v1/collections',
      schema: collectionReply,
      body: { title: `Showcase ${view}`, visibility: 'public', presentationKind: kind },
    });
    if (made.status !== 'current') {
      collections.push({ view, sources: current, ...made });
      continue;
    }
    const id = made.value;
    const path = `/v1/collections/${id}`;
    let failure: Failure | undefined;
    for (const source of current) {
      const member = await createNative({
        ...input,
        action: `${action}:member:${source.provider}:${source.externalId}`,
        path: `${path}/members`,
        body: { subjectId: source.subjectId },
        schema: memberReply,
      });
      if (member.status !== 'current') {
        failure = member;
        break;
      }
    }
    if (failure) {
      collections.push({ view, sources: current, id, ...failure });
      continue;
    }
    const creator = await receive(input.request, { path, audience: 'creator' }, collectionReply);
    const publicRead = await receive(input.request, { path, audience: 'public' }, collectionReply);
    const members = await receive(
      input.request,
      { path: `${path}/members?limit=100`, audience: 'creator' },
      membersReply,
    );
    const publicMembers = await receive(
      input.request,
      { path: `${path}/members?limit=100`, audience: 'public' },
      membersReply,
    );
    if (creator.status !== 'current') {
      collections.push({ view, sources: current, id, ...creator });
      continue;
    }
    if (publicRead.status !== 'current') {
      collections.push({ view, sources: current, id, ...publicRead });
      continue;
    }
    if (members.status !== 'current') {
      collections.push({ view, sources: current, id, ...members });
      continue;
    }
    if (publicMembers.status !== 'current') {
      collections.push({ view, sources: current, id, ...publicMembers });
      continue;
    }
    const expectedMembers = current.map((source) => ({
      id: input.journal.action(`${action}:member:${source.provider}:${source.externalId}`)!.result_id!,
      subjectId: source.subjectId,
    }));
    const currentCollection = (value: Collection) =>
      value.id === id &&
      value.curatorAccountId === input.accountId &&
      value.presentationKind === kind &&
      value.presentationKindSource === (kind === null ? 'mixed' : 'owner') &&
      value.visibility === 'public' &&
      value.memberCount === current.length;
    const currentMembers = (value: Static<typeof membersReply>) =>
      value.next === null &&
      JSON.stringify(value.members.map(({ id, subjectId }) => ({ id, subjectId }))) === JSON.stringify(expectedMembers);
    if (
      !currentCollection(creator.value.collection) ||
      !currentCollection(publicRead.value.collection) ||
      !currentMembers(members.value) ||
      !currentMembers(publicMembers.value)
    ) {
      collections.push({ view, sources: current, id, status: 'changed', code: 'current-collection-mismatch' });
      continue;
    }
    collections.push({
      view,
      sources: current,
      id,
      kind,
      status: 'current',
      creator: creator.value.collection,
      public: publicRead.value.collection,
      members: members.value.members,
    });
  }
  return {
    status: 'incomplete',
    collections,
    sources,
    workLinks: input.result.workLinks,
    edition: {
      status: 'producer-unavailable',
      producer: 'seedDevelopmentContentEdition',
      code: 'producer-contract-not-installed',
    },
    offer: { status: 'awaiting-content-edition' },
  };
}
