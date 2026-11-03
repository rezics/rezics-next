import type {
  PersonalEntry,
  PersonalEntryFieldChange,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceCorrection,
} from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import {
  correctPrivateSourceObservation,
  readPrivateEntry,
  writePrivateAnnotations,
  type AnnotationWriteResult,
  type SourceCorrectionResult,
} from './native';

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionIdentity = { viewer: string; csrfToken: string; authorization: string };

async function currentIdentity(): Promise<SessionIdentity | null> {
  const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
  return identity.state === 'signed-in' && identity.csrfToken
    ? { viewer: identity.subject, csrfToken: identity.csrfToken, authorization: identity.authorization }
    : null;
}

function subjectId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function textField(value: unknown): PersonalEntryFieldChange<string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('op' in value && value.op === 'clear') return { op: 'clear' };
  if ('op' in value && value.op === 'unchanged') return { op: 'unchanged' };
  if ('op' in value && value.op === 'set' && 'value' in value && typeof value.value === 'string')
    return { op: 'set', value: value.value };
  return null;
}

function priorityField(value: unknown): PersonalEntryFieldChange<number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('op' in value && value.op === 'clear') return { op: 'clear' };
  if ('op' in value && value.op === 'unchanged') return { op: 'unchanged' };
  if (
    'op' in value &&
    value.op === 'set' &&
    'value' in value &&
    typeof value.value === 'number' &&
    Number.isSafeInteger(value.value) &&
    value.value >= 1 &&
    value.value <= 100
  )
    return { op: 'set', value: value.value };
  return null;
}

function annotationInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const note = textField(item.note);
  const priority = priorityField(item.priority);
  if (!note || !priority || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) return null;
  return { revision: item.revision as number, note, priority };
}

function privacyValue(value: unknown): PersonalEntryPrivacyValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) return null;
  if (value.status === 'absent') return { status: 'absent' };
  if (
    value.status === 'known' &&
    'meaning' in value &&
    (value.meaning === 'private' || value.meaning === 'source_visible')
  )
    return { status: 'known', meaning: value.meaning };
  if (value.status === 'unknown') {
    if ('sourceValue' in value && typeof value.sourceValue === 'string' && value.sourceValue.length <= 192)
      return { status: 'unknown', sourceValue: value.sourceValue };
    return { status: 'unknown' };
  }
  return null;
}

function privacyChange(value: unknown): PersonalEntryFieldChange<PersonalEntryPrivacyValue> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('op' in value)) return null;
  if (value.op === 'clear') return { op: 'clear' };
  if (value.op === 'unchanged') return { op: 'unchanged' };
  if (value.op === 'set' && 'value' in value) {
    const parsed = privacyValue(value.value);
    return parsed ? { op: 'set', value: parsed } : null;
  }
  return null;
}

function annotationKey(value: unknown) {
  return typeof value === 'string' && keyPattern.test(value);
}

function expectedSession(value: Record<string, unknown>, identity: SessionIdentity) {
  return value.viewer === identity.viewer && value.csrfToken === identity.csrfToken;
}

export type PrivateEntryReadResult =
  | { kind: 'ready'; viewer: string; csrfToken: string; entry: PersonalEntry }
  | { kind: 'signed-out' | 'unavailable' };

export const readPrivateEntryForSubject = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    const id = value && typeof value === 'object' && 'subjectId' in value ? subjectId(value.subjectId) : null;
    if (!id) throw new Error('Invalid private entry address');
    return { subjectId: id };
  })
  .handler(async ({ data }): Promise<PrivateEntryReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity) return { kind: 'signed-out' };
    try {
      const result = await readPrivateEntry(kernelClient(), data.subjectId, identity.authorization);
      if (result.kind !== 'ready') return { kind: 'unavailable' };
      return { kind: 'ready', viewer: identity.viewer, csrfToken: identity.csrfToken, entry: result.entry };
    } catch {
      return { kind: 'unavailable' };
    }
  });

export type PrivateEntryCommandResult = AnnotationWriteResult | { kind: 'signed-out' };

export const savePrivateAnnotations = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid annotation command');
    const item = value as Record<string, unknown>;
    const id = subjectId(item.subjectId);
    const body = annotationInput(item.body);
    const key = typeof item.key === 'string' && annotationKey(item.key) ? item.key : null;
    const viewer = typeof item.viewer === 'string' ? item.viewer : null;
    const csrfToken = typeof item.csrfToken === 'string' ? item.csrfToken : null;
    if (!id || !body || !key || !viewer || !csrfToken) throw new Error('Invalid annotation command');
    return { subjectId: id, body, key, viewer, csrfToken };
  })
  .handler(async ({ data }): Promise<PrivateEntryCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || !expectedSession(data, identity)) return { kind: 'signed-out' };
    try {
      return await writePrivateAnnotations(kernelClient(), {
        subjectId: data.subjectId,
        body: data.body,
        key: data.key,
        authorization: identity.authorization,
      });
    } catch {
      return { kind: 'uncertain' };
    }
  });

export type SourcePrivacyCommandResult =
  | { kind: 'saved'; entry: PersonalEntry; observation: import('@rezics/client').PersonalEntryObservation }
  | Exclude<SourceCorrectionResult, { kind: 'saved' }>
  | { kind: 'signed-out' };

export const savePrivateSourcePrivacy = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source correction');
    const item = value as Record<string, unknown>;
    const id = subjectId(item.subjectId);
    const privacy = privacyChange(item.privacy);
    const provider =
      typeof item.provider === 'string' && item.provider.length >= 1 && item.provider.length <= 64
        ? item.provider
        : null;
    const recordId =
      typeof item.recordId === 'string' && item.recordId.length >= 1 && item.recordId.length <= 192
        ? item.recordId
        : null;
    const key = typeof item.key === 'string' && annotationKey(item.key) ? item.key : null;
    const viewer = typeof item.viewer === 'string' ? item.viewer : null;
    const csrfToken = typeof item.csrfToken === 'string' ? item.csrfToken : null;
    if (
      !id ||
      !privacy ||
      !provider ||
      !recordId ||
      !Number.isSafeInteger(item.revision) ||
      !key ||
      !viewer ||
      !csrfToken
    )
      throw new Error('Invalid source correction');
    const body: PersonalEntrySourceCorrection = {
      provider,
      recordId,
      revision: item.revision as number,
      confirmReviewed: true,
      privacy,
      sourceCreated: { op: 'unchanged' },
      sourceUpdated: { op: 'unchanged' },
    };
    return {
      subjectId: id,
      body,
      key,
      viewer,
      csrfToken,
    };
  })
  .handler(async ({ data }): Promise<SourcePrivacyCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || !expectedSession(data, identity)) return { kind: 'signed-out' };
    try {
      const result = await correctPrivateSourceObservation(kernelClient(), {
        subjectId: data.subjectId,
        body: data.body,
        key: data.key,
        authorization: identity.authorization,
      });
      if (result.kind !== 'saved') return result;
      const refreshed = await readPrivateEntry(kernelClient(), data.subjectId, identity.authorization);
      return refreshed.kind === 'ready' &&
        refreshed.entry.sourceObservations.some(
          (observation) =>
            observation.provider === data.body.provider &&
            observation.recordId === data.body.recordId &&
            observation.revision >= result.observation.revision,
        )
        ? { kind: 'saved', entry: refreshed.entry, observation: result.observation }
        : { kind: 'uncertain' };
    } catch {
      return { kind: 'uncertain' };
    }
  });
