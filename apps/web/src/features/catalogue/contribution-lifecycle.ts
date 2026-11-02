import type { KernelClient } from '@rezics/client';
import { candidateContext } from '../../subject/candidates';

export type ContributionAddress = { id: string; candidate: string; property: string; session?: string };
export type ContributionCommand = ContributionAddress & { operation: 'delete' | 'restore'; key: string };
export type ContributionFailure = {
  ok: false;
  reason: 'denied' | 'expired' | 'conflict' | 'invalid' | 'unavailable';
};
export type ContributionAvailability = {
  subject: 'available' | 'unavailable';
  candidate: 'available' | 'deleted' | 'unconfirmed';
  selected: boolean | null;
  session?: string;
};
export type ContributionResult =
  | ContributionFailure
  | { ok: true; operation: ContributionCommand['operation']; current: ContributionAvailability; session?: string };
export type ContributionTransport = {
  change: (command: ContributionCommand) => Promise<ContributionResult>;
  read: (address: ContributionAddress) => Promise<ContributionAvailability>;
};

/** Only a current, visible candidate observation can choose a new operation. */
export function confirmedContributionOperation(current: ContributionAvailability) {
  if (current.subject !== 'available' || current.candidate === 'unconfirmed') return null;
  return current.candidate === 'deleted' ? 'restore' : 'delete';
}

type ContributionEndpoint = ReturnType<ReturnType<KernelClient['subjects']>['candidates']>;

export function contributionAddressInput(value: unknown): ContributionAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid contribution command');
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    typeof input.candidate !== 'string' ||
    !uuid.test(input.candidate) ||
    typeof input.property !== 'string' ||
    !input.property ||
    input.property.length > 256 ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
  )
    throw new Error('Invalid contribution command');
  return {
    id: input.id,
    candidate: input.candidate,
    property: input.property,
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
  };
}

export function contributionInput(value: unknown): ContributionCommand {
  const address = contributionAddressInput(value);
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof input.key !== 'string' ||
    !uuid.test(input.key) ||
    (input.operation !== 'delete' && input.operation !== 'restore') ||
    Object.keys(input).some((key) => !['id', 'candidate', 'property', 'operation', 'key', 'session'].includes(key))
  )
    throw new Error('Invalid contribution command');
  return { ...address, key: input.key, operation: input.operation };
}

/** Return only current availability, never a private candidate, old payload or author profile. */
export async function readContributionAvailability(
  client: KernelClient,
  authorization: string,
  address: ContributionAddress,
): Promise<ContributionAvailability> {
  const headers = { authorization, ...(address.session ? { 'rezics-session-token': address.session } : {}) };
  const [subject, candidates] = await Promise.allSettled([
    client.subjects({ id: address.id }).get({ headers }),
    client.subjects({ id: address.id }).candidates.get({
      headers,
      query: { context: candidateContext, property: address.property, limit: 20 },
    }),
  ]);
  const current = subject.status === 'fulfilled' ? subject.value : undefined;
  const page = candidates.status === 'fulfilled' ? candidates.value : undefined;
  const visible =
    current?.status === 200 &&
    current.data?.subject.id === address.id &&
    current.data.subject.context === candidateContext;
  const item = page?.status === 200 ? page.data?.candidates.find((item) => item.id === address.candidate) : undefined;
  const token = page ? new Headers(page.headers).get('rezics-session-token') : null;
  return {
    subject: visible ? 'available' : 'unavailable',
    // `deleted: true` is the declared native tombstone. Absence on a bounded page proves nothing more.
    candidate: item ? ('deleted' in item && item.deleted === true ? 'deleted' : 'available') : 'unconfirmed',
    selected: visible
      ? (current.data!.subject.statements[address.property] ?? []).some(
          (statement) =>
            statement.id === address.candidate && (statement.rank === 'normal' || statement.rank === 'preferred'),
        )
      : null,
    ...(token ? { session: token } : {}),
  };
}

export async function changeContribution(
  client: KernelClient,
  authorization: string,
  command: ContributionCommand,
): Promise<ContributionResult> {
  let response: Awaited<ReturnType<ContributionEndpoint['delete']>>;
  try {
    const endpoint = client.subjects({ id: command.id }).candidates({ candidate: command.candidate });
    const options = {
      headers: {
        authorization,
        'idempotency-key': command.key,
        ...(command.session ? { 'rezics-session-token': command.session } : {}),
      },
    };
    // Eden treats DELETE as a body-bearing verb: headers belong in its second argument.
    response =
      command.operation === 'delete'
        ? await endpoint.delete(undefined, options)
        : await endpoint.$restoreDeleted.post({}, options);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status !== 200)
    return {
      ok: false,
      reason:
        response.status === 401 || response.status === 403
          ? 'denied'
          : response.status === 409
            ? command.operation === 'restore'
              ? 'expired'
              : 'conflict'
            : response.status === 400 || response.status === 422
              ? 'invalid'
              : 'unavailable',
    };
  const result = response.data;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.keys(result).length !== 3 ||
    result.subject !== command.id ||
    result.candidate !== command.candidate ||
    result.deleted !== (command.operation === 'delete')
  )
    // The effect is uncertain. Keep the original command/key retryable without claiming a local change.
    return { ok: false, reason: 'unavailable' };
  let session = new Headers(response.headers).get('rezics-session-token') ?? command.session;
  let current: ContributionAvailability;
  try {
    current = await readContributionAvailability(client, authorization, {
      ...command,
      ...(session ? { session } : {}),
    });
  } catch {
    // A validated effect remains successful even if the subsequent observation fails.
    current = { subject: 'unavailable', candidate: 'unconfirmed', selected: null };
  }
  session = current.session ?? session;
  return { ok: true, operation: command.operation, current, ...(session ? { session } : {}) };
}
