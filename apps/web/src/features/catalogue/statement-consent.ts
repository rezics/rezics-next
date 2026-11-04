import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { candidateContext, candidateHasPayload, type Candidate, type CandidateSlot } from '../../subject/candidates';

export type ConsentAddress = { id: string; property: string; candidate: string; slot?: CandidateSlot };
export type ConsentCommand = ConsentAddress & { operation: 'disclose' | 'retract'; key: string; session?: string };
export type ConsentFailure = { ok: false; reason: 'denied' | 'missing' | 'invalid' | 'conflict' | 'unavailable' };
export type ConsentPublic =
  | { state: 'present'; statement: Candidate['statement']; related: SubjectRead['related'] }
  | { state: 'absent' | 'pending' | ConsentFailure['reason'] };
export type ConsentActions =
  | { state: 'available'; disclosed: boolean; operations: ('statement.disclose' | 'statement.retract')[] }
  | { state: 'refused' | 'terminal' | 'unavailable' | 'not-applicable' };
export type ConsentRead =
  | ConsentFailure
  | {
      ok: true;
      candidate: Candidate | null;
      terminal: boolean;
      disclosure: boolean;
      field: Record<string, string>;
      actions: ConsentActions;
      public: ConsentPublic;
      next: string | null;
      session?: string;
    };
export type ConsentResult =
  | ConsentFailure
  | {
      ok: true;
      kind: 'disclosed' | 'retracted';
      actions: ConsentActions;
      public: ConsentPublic;
      session?: string;
    };
export type ConsentTransport = {
  read: (cursor?: string, session?: string) => Promise<ConsentRead>;
  change: (command: ConsentCommand) => Promise<ConsentResult>;
  public: (session?: string, terminal?: boolean) => Promise<ConsentPublic>;
};

/** All three names belong to the admitted candidate and its exact pinned property. */
export function consentAssertion(read: Extract<ConsentRead, { ok: true }>, address: ConsentAddress, locale: string) {
  const candidate = read.candidate;
  const identity = candidate?.consentIdentity;
  const bound =
    candidate?.id === address.candidate &&
    candidate.statement.id === address.candidate &&
    candidate.statement.property.id === address.property &&
    candidate.statement.property.data_type === 'wikibase-item' &&
    candidate.retracted === null &&
    !read.terminal;
  // Blank labels cannot identify a consequential command. Keep authored text and locale fallback intact.
  const name = (labels: Record<string, string>) =>
    pickText(Object.fromEntries(Object.entries(labels).filter(([, text]) => text.trim())), locale);
  const subject = name(bound && identity?.subject?.id === address.id ? identity.subject.labels : {});
  const relationship = name(bound ? read.field : {});
  const target = name(
    bound &&
      candidate.statement.value.type === 'value' &&
      identity?.target &&
      identity.target.id === candidate.statement.value.content &&
      (!address.slot?.target || address.slot.target === identity.target.id)
      ? identity.target.labels
      : {},
  );
  const identified = bound && !!subject.text && !!relationship.text && !!target.text;
  return { subject, relationship, target, identified };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function consentSelection(value: unknown): Omit<ConsentAddress, 'id'> {
  if (!value || typeof value !== 'object') throw new Error('Invalid consent address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.candidate !== 'string' ||
    !uuid.test(input.candidate) ||
    typeof input.property !== 'string' ||
    !input.property ||
    input.property.length > 256
  )
    throw new Error('Invalid consent address');
  let slot: CandidateSlot | undefined;
  if (input.slot !== undefined) {
    if (!input.slot || typeof input.slot !== 'object') throw new Error('Invalid consent slot');
    const given = input.slot as Record<string, unknown>;
    if (
      Object.keys(given).some((key) => !['target', 'sameAs', 'key'].includes(key)) ||
      (given.target !== undefined && (typeof given.target !== 'string' || !uuid.test(given.target))) ||
      (given.key !== undefined && (typeof given.key !== 'string' || !uuid.test(given.key))) ||
      (given.sameAs !== undefined &&
        (typeof given.sameAs !== 'string' || !given.sameAs || given.sameAs.length > 2048)) ||
      (given.target !== undefined && given.sameAs !== undefined) ||
      (given.key !== undefined && given.target === undefined)
    )
      throw new Error('Invalid consent slot');
    slot = {
      ...(typeof given.target === 'string' ? { target: given.target } : {}),
      ...(typeof given.sameAs === 'string' ? { sameAs: given.sameAs } : {}),
      ...(typeof given.key === 'string' ? { key: given.key } : {}),
    };
  }
  return { property: input.property, candidate: input.candidate, ...(slot ? { slot } : {}) };
}
export function consentAddress(value: unknown): ConsentAddress {
  const selection = consentSelection(value);
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !uuid.test(input.id)) throw new Error('Invalid consent subject');
  return { id: input.id, ...selection };
}
export function consentCommand(value: unknown): ConsentCommand {
  const address = consentAddress(value);
  const input = value as Record<string, unknown>;
  if (
    (input.operation !== 'disclose' && input.operation !== 'retract') ||
    typeof input.key !== 'string' ||
    !uuid.test(input.key) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
  )
    throw new Error('Invalid consent command');
  return {
    ...address,
    operation: input.operation,
    key: input.key,
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
  };
}
export function consentFailure(status: number): ConsentFailure {
  return {
    ok: false,
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 404
          ? 'missing'
          : status === 409 || status === 422
            ? 'conflict'
            : status === 400
              ? 'invalid'
              : 'unavailable',
  };
}

/** This read is always anonymous, even when its freshness token came from the session's command. */
export async function readConsentPublic(
  client: KernelClient,
  address: ConsentAddress,
  session?: string,
  terminal = false,
): Promise<ConsentPublic> {
  try {
    const result = await client.subjects({ id: address.id }).get({
      headers: { ...(session ? { 'rezics-session-token': session } : {}) },
      fetch: { cache: 'no-store' },
    });
    if (result.status !== 200 || !result.data) return { state: consentFailure(result.status).reason };
    if (result.data.subject.id !== address.id || result.data.subject.context !== candidateContext)
      return { state: 'conflict' };
    const statement = result.data.subject.statements[address.property]?.find(
      (statement) =>
        statement.id === address.candidate && (statement.rank === 'normal' || statement.rank === 'preferred'),
    );
    // A lagging public reader after terminal retraction may report presence, but never retain its withheld body.
    return statement
      ? terminal
        ? { state: 'pending' }
        : { state: 'present', statement, related: result.data.related }
      : { state: 'absent' };
  } catch {
    return { state: 'unavailable' };
  }
}

/** Native viewer operations are a separate, failure-isolated component of the private read. */
export async function readConsentActions(
  client: KernelClient,
  authorization: string,
  address: ConsentAddress,
  session?: string,
): Promise<ConsentActions> {
  try {
    const result = await client.statements({ id: address.candidate }).consent.get({
      query: { subject: address.id, property: address.property, ...address.slot },
      headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
      fetch: { cache: 'no-store' },
    });
    if (result.status !== 200 || !result.data)
      return { state: result.status === 401 || result.status === 403 || result.status === 404 ? 'refused' : 'unavailable' };
    if (result.data.state !== 'available') return { state: result.data.state };
    return {
      state: 'available',
      disclosed: result.data.disclosed,
      operations: result.data.operations.filter(
        (operation): operation is 'statement.disclose' | 'statement.retract' =>
          operation === 'statement.disclose' || operation === 'statement.retract',
      ),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

/** A bounded native candidate page supplies identity and state, never an ownership/permission mirror. */
export async function readStatementConsent(
  client: KernelClient,
  authorization: string,
  address: ConsentAddress,
  cursor?: string,
  session?: string,
): Promise<ConsentRead> {
  try {
    const [page, current] = await Promise.all([
      client.subjects({ id: address.id }).candidates.get({
        query: {
          property: address.property,
          context: candidateContext,
          ...address.slot,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        },
        headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
        fetch: { cache: 'no-store' },
      }),
      readConsentPublic(client, address, session),
    ]);
    if (page.status !== 200 || !page.data) return consentFailure(page.status);
    const token = new Headers(page.headers).get('rezics-session-token') ?? session;
    const candidate = page.data.candidates.find((item) => item.id === address.candidate);
    if (!candidate)
      return {
        ok: true,
        candidate: null,
        terminal: false,
        disclosure: false,
        field: {},
        actions: { state: 'not-applicable' },
        public: current,
        next: page.data.next,
        ...(token ? { session: token } : {}),
      };
    // A deleted marker withholds the entire read, including a lagging public body. It proves no retraction.
    if (!candidateHasPayload(candidate)) return consentFailure(404);
    if (candidate.statement.id !== address.candidate || candidate.statement.property.id !== address.property)
      return consentFailure(409);
    if (candidate.retracted !== null)
      return {
        ok: true,
        candidate: null,
        terminal: true,
        disclosure: false,
        field: {},
        actions: { state: 'terminal' },
        public: current.state === 'present' ? { state: 'pending' } : current,
        next: null,
        ...(token ? { session: token } : {}),
      };
    const definitions = await client.definitions.releases({ digest: candidate.release }).get();
    if (definitions.status !== 200 || !definitions.data) return consentFailure(definitions.status);
    const property = (definitions.data.release as Release).properties[address.property];
    if (definitions.data.digest !== candidate.release || !property) return consentFailure(503);
    const disclosure = property.disclosure === 'sourceOrConsent';
    const applicable = disclosure && candidate.statement.references.length === 0;
    const actions = applicable
      ? await readConsentActions(client, authorization, address, token)
      : { state: 'not-applicable' as const };
    if (actions.state === 'terminal')
      return {
        ok: true,
        candidate: null,
        terminal: true,
        disclosure: false,
        field: {},
        actions,
        public: current.state === 'present' ? { state: 'pending' as const } : current,
        next: null,
        ...(token ? { session: token } : {}),
      };
    return {
      ok: true,
      candidate,
      terminal: false,
      disclosure,
      field: property.labels,
      actions,
      public: current,
      next: null,
      ...(token ? { session: token } : {}),
    };
  } catch {
    return consentFailure(503);
  }
}

/** Generated native methods own current target-account authority, disclosure evidence and receipted replay. */
export async function changeStatementConsent(
  client: KernelClient,
  authorization: string,
  command: ConsentCommand,
): Promise<ConsentResult> {
  try {
    const endpoint = client.statements({ id: command.candidate });
    const options = {
      headers: {
        authorization,
        'idempotency-key': JSON.stringify(command.key),
        ...(command.session ? { 'rezics-session-token': command.session } : {}),
      },
      fetch: { cache: 'no-store' as const },
    };
    const result =
      command.operation === 'disclose'
        ? await endpoint.disclose.post(undefined, options)
        : await endpoint.retract.post(undefined, options);
    if (result.status !== 200 || !result.data) return consentFailure(result.status);
    if (result.data.candidate !== command.candidate) return consentFailure(503);
    const session = new Headers(result.headers).get('rezics-session-token') ?? command.session;
    const actions =
      command.operation === 'retract'
        ? { state: 'terminal' as const }
        : await readConsentActions(client, authorization, command, session);
    return {
      ok: true,
      kind: command.operation === 'disclose' ? 'disclosed' : 'retracted',
      actions,
      public: await readConsentPublic(client, command, session, command.operation === 'retract' || actions.state === 'terminal'),
      ...(session ? { session } : {}),
    };
  } catch {
    return consentFailure(503);
  }
}

/** Confirmed terminal responses cannot carry the private assertion forward into component state. */
export function consentAfterChange(
  read: Extract<ConsentRead, { ok: true }>,
  result: Extract<ConsentResult, { ok: true }>,
): Extract<ConsentRead, { ok: true }> {
  return {
    ...read,
    ...(result.kind === 'retracted' || result.actions.state === 'terminal' ? { candidate: null, terminal: true } : {}),
    public: result.public,
    actions: result.actions,
    ...(result.session ? { session: result.session } : {}),
  };
}
