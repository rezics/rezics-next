import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import * as v from 'valibot';

const id = v.pipe(v.string(), v.uuid());
const title = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const summary = v.pipe(v.string(), v.maxLength(4096));
const visibility = v.picklist(['public', 'protected']);
const common = { key: id };
export const setupCommandSchema = v.variant('step', [
  v.strictObject({ ...common, step: v.literal('space'), title, summary }),
  v.strictObject({
    ...common,
    step: v.literal('address'),
    spaceId: id,
    head: id,
    address: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  }),
  v.strictObject({ ...common, step: v.literal('realm'), spaceId: id, title, summary, visibility, contextId: id }),
  v.strictObject({
    ...common,
    step: v.literal('settings'),
    realmId: id,
    head: id,
    title,
    summary,
    visibility,
    contextId: id,
  }),
  v.strictObject({ ...common, step: v.literal('scheme'), realmId: id, head: id, schemeId: id }),
  v.strictObject({
    ...common,
    step: v.literal('board'),
    realmId: id,
    conceptId: id,
    title,
    visibility: v.picklist(['published', 'protected', 'draft']),
    purpose: v.picklist(['discussion', 'reviews']),
  }),
]);
export type SetupCommand = v.InferOutput<typeof setupCommandSchema>;
export type SetupDraftCommand = SetupCommand extends infer C
  ? C extends SetupCommand
    ? Omit<C, 'key'>
    : never
  : never;
export type SetupSpace = {
  id: string;
  head: string;
  title: string;
  summary: string;
  address: string | null;
  realmId: string | null;
};
export type SetupRealm = {
  id: string;
  head: string;
  title: string;
  summary: string;
  visibility: 'public' | 'protected';
  contextId: string;
  schemeId: string | null;
};
export type SetupFailure = {
  kind: 'failure';
  reason: 'conflict' | 'denied' | 'invalid' | 'unavailable';
  status: number;
  /** Actual reader from the same prepared request; absent on local and standalone results. */
  reader?: SetupReaderProvenance;
};
/** A browser may compare a server read with its current subject without receiving credentials. */
export type SetupReaderProvenance = { kind: 'session'; subject: string } | { kind: 'unbound' };
export function setupReaderMatches(reader: SetupReaderProvenance | undefined, expectedSubject: string | null): boolean {
  return reader?.kind === 'session' && !!expectedSubject && reader.subject === expectedSubject;
}
export type SetupResult =
  | SetupFailure
  | { kind: 'space'; space: SetupSpace }
  | { kind: 'realm'; realm: SetupRealm }
  | { kind: 'board'; id: string };
export type SetupSnapshot = {
  kind: 'ready';
  space: SetupSpace | null;
  realm: SetupRealm | null;
  permitted: { address: boolean; settings: boolean; scheme: boolean; board: boolean };
  /** Additive, serializable provenance supplied by the setup server wrappers. */
  reader?: SetupReaderProvenance;
};

export function applySetupResult(snapshot: SetupSnapshot, result: SetupResult): SetupSnapshot {
  if (result.kind === 'space') return { ...snapshot, space: result.space };
  if (result.kind === 'realm')
    return {
      ...snapshot,
      realm: result.realm,
      space: snapshot.space ? { ...snapshot.space, realmId: result.realm.id } : null,
    };
  return snapshot;
}
export type SetupChoice = { id: string; label: string; reader?: SetupReaderProvenance };
export const setupReadSchema = v.strictObject({ spaceId: v.optional(id) });
export const setupChoiceSchema = v.strictObject({ id, kind: v.picklist(['context', 'scheme', 'concept']) });
type Auth = { headers: { authorization: string } };
type Response<T> = { data: T | null; error: unknown; status: number };

function failure(status: number): SetupFailure {
  return {
    kind: 'failure',
    status,
    reason:
      status === 409 || status === 412
        ? 'conflict'
        : status === 401 || status === 403 || status === 404
          ? 'denied'
          : status >= 400 && status < 500
            ? 'invalid'
            : 'unavailable',
  };
}
function read<T>(result: Response<T>): T | SetupFailure {
  return result.error || !result.data || result.status >= 400 ? failure(result.status) : result.data;
}
function failed(value: unknown): value is SetupFailure {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'failure';
}
type SpaceWire = NonNullable<Awaited<ReturnType<KernelClient['spaces']['post']>>['data']>['space'];
type RealmWire = NonNullable<Awaited<ReturnType<KernelClient['realms']['post']>>['data']>['realm'];
function spaceOf(space: SpaceWire): SetupSpace {
  return {
    id: space.spaceId,
    head: space.headRevisionId,
    title: space.title,
    summary: space.summary,
    address: space.address,
    realmId: space.realmId,
  };
}
function realmOf(realm: RealmWire): SetupRealm {
  return {
    id: realm.realmId,
    head: realm.headRevisionId,
    title: realm.title,
    summary: realm.summary,
    visibility: realm.visibility,
    contextId: realm.contextId,
    schemeId: realm.boardSchemeId,
  };
}

/** Receipt retries keep the complete original command, including its expected head. */
export function setupAttempt(previous: SetupCommand | null, draft: SetupDraftCommand, key: string): SetupCommand {
  return previous ?? Object.freeze({ ...draft, key });
}
/** A definite refusal permits editing; an ambiguous outcome must first replay the saved request. */
export function retainSetupAttempt(result: SetupResult): boolean {
  return result.kind === 'failure' && result.reason === 'unavailable';
}

export async function commandSetup(
  client: KernelClient,
  authorization: string,
  command: SetupCommand,
): Promise<SetupResult> {
  const headers = { authorization, 'idempotency-key': JSON.stringify(command.key) };
  const match = { headers: { ...headers, 'if-match': 'head' in command ? JSON.stringify(command.head) : '' } };
  switch (command.step) {
    case 'space': {
      const data = read(await client.spaces.post({ title: command.title, summary: command.summary }, { headers }));
      return failed(data) ? data : { kind: 'space', space: spaceOf(data.space) };
    }
    case 'address': {
      const data = read(
        await client.spaces({ spaceId: command.spaceId }).address.put({ address: command.address }, match),
      );
      return failed(data) ? data : { kind: 'space', space: spaceOf(data.space) };
    }
    case 'realm': {
      const { spaceId, title, summary, visibility, contextId } = command;
      const data = read(await client.realms.post({ spaceId, title, summary, visibility, contextId }, { headers }));
      return failed(data) ? data : { kind: 'realm', realm: realmOf(data.realm) };
    }
    case 'settings': {
      const { title, summary, visibility, contextId } = command;
      const data = read(
        await client.realms({ realmId: command.realmId }).patch({ title, summary, visibility, contextId }, match),
      );
      return failed(data) ? data : { kind: 'realm', realm: realmOf(data.realm) };
    }
    case 'scheme': {
      const data = read(
        await client.realms({ realmId: command.realmId }).boardScheme.put({ schemeId: command.schemeId }, match),
      );
      return failed(data) ? data : { kind: 'realm', realm: realmOf(data.realm) };
    }
    case 'board': {
      const { title, conceptId, visibility, purpose } = command;
      const data = read(
        await client
          .realms({ realmId: command.realmId })
          .boards.post({ title, conceptId, visibility, purpose }, { headers }),
      );
      return failed(data) ? data : { kind: 'board', id: data.board.id };
    }
  }
}

/** At most two resource point reads and one bounded current-action batch. */
export async function readSetup(
  client: KernelClient,
  authorization: string,
  spaceId?: string,
): Promise<SetupSnapshot | SetupFailure> {
  const auth: Auth = { headers: { authorization } };
  if (!spaceId)
    return {
      kind: 'ready',
      space: null,
      realm: null,
      permitted: { address: false, settings: false, scheme: false, board: false },
    };
  const spaceData = read(await client.spaces({ spaceId }).get(auth));
  if (failed(spaceData)) return spaceData;
  const space = spaceOf(spaceData.space);
  let realm: SetupRealm | null = null;
  if (space.realmId) {
    const realmData = read(await client.realms({ realmId: space.realmId }).get(auth));
    if (failed(realmData)) return realmData;
    realm = realmOf(realmData.realm);
  }
  const data = read(
    await client.viewerActions.post(
      {
        resources: [
          { type: 'community.space', id: space.id },
          ...(realm ? [{ type: 'community.realm', id: realm.id }] : []),
        ],
      },
      auth,
    ),
  );
  if (failed(data)) return data;
  const permits = (id: string | undefined, operation: string) =>
    data.resources.some(
      (resource) =>
        resource.id === id &&
        'viewerActions' in resource &&
        resource.viewerActions.some((action) => action.operations.includes(operation)),
    );
  return {
    kind: 'ready',
    space,
    realm,
    permitted: {
      address: permits(space.id, 'space_address.change'),
      settings: permits(realm?.id, 'realm.update'),
      scheme: permits(realm?.id, 'realm.board_scheme'),
      board: permits(realm?.id, 'board.create'),
    },
  };
}

/** Resolve one existing selection. The write revalidates current readability and scheme membership. */
export async function readSetupChoice(
  client: KernelClient,
  authorization: string,
  input: v.InferOutput<typeof setupChoiceSchema>,
  locale = 'en',
): Promise<SetupChoice | SetupFailure> {
  const auth: Auth = { headers: { authorization } };
  if (input.kind === 'context') {
    const data = read(await client.contexts({ id: input.id }).get(auth));
    return failed(data)
      ? data
      : { id: data.context.id, label: pickText(data.context.labels, locale).text || data.context.id };
  }
  const data = read(await client.subjects({ id: input.id }).get(auth));
  if (failed(data)) return data;
  if (data.subject.type !== (input.kind === 'scheme' ? 'skos:ConceptScheme' : 'skos:Concept')) return failure(400);
  return {
    id: data.subject.id,
    label: data.summary?.label?.value ?? Object.values(data.subject.labels)[0] ?? data.subject.type,
  };
}
