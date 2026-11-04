import type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryFieldChange,
  PersonalEntryGuard,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampInput,
} from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import {
  admitPrivateSourceObservation,
  correctPrivateSourceObservation,
  readPrivateEntry,
  writePrivateAnnotations,
  type AnnotationWriteResult,
  type SourceAdmissionResult,
  type SourceCorrectionResult,
} from './native';

import { captureAnnotationCredential, originalAnnotationCredential } from './credential';

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

export function annotationInput(value: unknown): PersonalEntryAnnotationWrite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const note = textField(item.note);
  const priority = priorityField(item.priority);
  if (!note || !priority || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) return null;
  const guard = item.entryGuard;
  if (
    !guard ||
    typeof guard !== 'object' ||
    Array.isArray(guard) ||
    !('incarnationId' in guard) ||
    typeof guard.incarnationId !== 'string' ||
    !keyPattern.test(guard.incarnationId) ||
    !('currentRevision' in guard) ||
    typeof guard.currentRevision !== 'number' ||
    !Number.isSafeInteger(guard.currentRevision) ||
    guard.currentRevision < 1
  )
    return null;
  return {
    revision: item.revision as number,
    note,
    priority,
    entryGuard: { incarnationId: guard.incarnationId, currentRevision: guard.currentRevision },
  };
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
    if ('sourceValue' in value)
      return typeof value.sourceValue === 'string' &&
        value.sourceValue.length > 0 &&
        new TextEncoder().encode(value.sourceValue).byteLength <= 192 &&
        !/[\u0000-\u001f\u007f]/.test(value.sourceValue)
        ? { status: 'unknown', sourceValue: value.sourceValue }
        : null;
    return { status: 'unknown' };
  }
  return null;
}

function timestampValue(value: unknown): PersonalEntryTimestampInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) return null;
  if (value.status === 'absent') return { status: 'absent' };
  if (value.status === 'known' && 'value' in value && typeof value.value === 'string' && value.value.length <= 64)
    return { status: 'known', value: value.value };
  if (value.status === 'unknown') {
    if ('sourceValue' in value)
      return typeof value.sourceValue === 'string' &&
        value.sourceValue.length > 0 &&
        new TextEncoder().encode(value.sourceValue).byteLength <= 64 &&
        !/[\u0000-\u001f\u007f]/.test(value.sourceValue)
        ? { status: 'unknown', sourceValue: value.sourceValue }
        : null;
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

function timestampChange(value: unknown): PersonalEntryFieldChange<PersonalEntryTimestampInput> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('op' in value)) return null;
  if (value.op === 'clear') return { op: 'clear' };
  if (value.op === 'unchanged') return { op: 'unchanged' };
  if (value.op === 'set' && 'value' in value) {
    const parsed = timestampValue(value.value);
    return parsed ? { op: 'set', value: parsed } : null;
  }
  return null;
}

function annotationKey(value: unknown) {
  return typeof value === 'string' && keyPattern.test(value);
}

function sourceEntryGuard(value: unknown): Pick<PersonalEntryGuard, 'incarnationId' | 'currentRevision'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const guard = value as Record<string, unknown>;
  return typeof guard.incarnationId === 'string' &&
    keyPattern.test(guard.incarnationId) &&
    Number.isSafeInteger(guard.currentRevision) &&
    (guard.currentRevision as number) >= 1
    ? { incarnationId: guard.incarnationId, currentRevision: guard.currentRevision as number }
    : null;
}

function expectedSession(value: Record<string, unknown>, identity: SessionIdentity) {
  return value.viewer === identity.viewer && value.csrfToken === identity.csrfToken;
}

export type PrivateEntryReadResult =
  | { kind: 'ready'; viewer: string; csrfToken: string; credential: string; entry: PersonalEntry }
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
      return {
        kind: 'ready',
        viewer: identity.viewer,
        csrfToken: identity.csrfToken,
        credential: await captureAnnotationCredential(
          getRequest(),
          env as Partial<SessionEnv>,
          identity,
          data.subjectId,
        ),
        entry: result.entry,
      };
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
    const credential =
      typeof item.credential === 'string' && /^[A-Za-z0-9_-]{1,6400}$/.test(item.credential) ? item.credential : null;
    if (!id || !body || !key || !viewer || !csrfToken || !credential) throw new Error('Invalid annotation command');
    return { subjectId: id, body, key, viewer, csrfToken, credential };
  })
  .handler(async ({ data }): Promise<PrivateEntryCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const session = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
    if (session.state === 'unavailable') return { kind: 'uncertain' };
    if (session.state !== 'signed-in' || !session.csrfToken) return { kind: 'signed-out' };
    const identity = { viewer: session.subject, csrfToken: session.csrfToken, authorization: session.authorization };
    const authorization = await originalAnnotationCredential(getRequest(), env as Partial<SessionEnv>, identity, data);
    if (!authorization) return { kind: 'retired' };
    try {
      return await writePrivateAnnotations(kernelClient(), {
        subjectId: data.subjectId,
        body: data.body,
        key: data.key,
        authorization,
      });
    } catch {
      return { kind: 'uncertain' };
    }
  });

export type SourceAdmissionCommandResult = SourceAdmissionResult | { kind: 'signed-out' };

export const admitPrivateSourceForSubject = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source admission');
    const item = value as Record<string, unknown>;
    const id = subjectId(item.subjectId);
    const provider =
      typeof item.provider === 'string' && item.provider.length >= 1 && item.provider.length <= 64
        ? item.provider
        : null;
    const recordId =
      typeof item.recordId === 'string' && item.recordId.length >= 1 && item.recordId.length <= 192
        ? item.recordId
        : null;
    const privacy = privacyValue(item.privacy);
    const sourceCreated = timestampValue(item.sourceCreated);
    const sourceUpdated = timestampValue(item.sourceUpdated);
    const key = typeof item.key === 'string' && annotationKey(item.key) ? item.key : null;
    if (
      !id ||
      !provider ||
      !recordId ||
      !privacy ||
      !sourceCreated ||
      !sourceUpdated ||
      !key ||
      item.confirmReviewed !== true
    )
      throw new Error('Invalid source admission');
    const body: PersonalEntrySourceAdmission = {
      provider,
      recordId,
      confirmReviewed: true,
      privacy,
      sourceCreated,
      sourceUpdated,
    };
    return { subjectId: id, body, key };
  })
  .handler(async ({ data }): Promise<SourceAdmissionCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity) return { kind: 'signed-out' };
    try {
      return await admitPrivateSourceObservation(kernelClient(), {
        subjectId: data.subjectId,
        body: data.body,
        key: data.key,
        authorization: identity.authorization,
      });
    } catch {
      return { kind: 'uncertain' };
    }
  });

export type SourceCorrectionCommandResult =
  | { kind: 'saved'; entry: PersonalEntry; observation: import('@rezics/client').PersonalEntryObservation }
  | Exclude<SourceCorrectionResult, { kind: 'saved' }>
  | { kind: 'signed-out' | 'unavailable' };

export const savePrivateSourceCorrection = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source correction');
    const item = value as Record<string, unknown>;
    const id = subjectId(item.subjectId);
    const input = item.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid source correction');
    const bodyInput = input as Record<string, unknown>;
    const privacy = privacyChange(bodyInput.privacy);
    const sourceCreated = timestampChange(bodyInput.sourceCreated);
    const sourceUpdated = timestampChange(bodyInput.sourceUpdated);
    const provider =
      typeof bodyInput.provider === 'string' && bodyInput.provider.length >= 1 && bodyInput.provider.length <= 64
        ? bodyInput.provider
        : null;
    const recordId =
      typeof bodyInput.recordId === 'string' && bodyInput.recordId.length >= 1 && bodyInput.recordId.length <= 192
        ? bodyInput.recordId
        : null;
    const key = typeof item.key === 'string' && annotationKey(item.key) ? item.key : null;
    const viewer = typeof item.viewer === 'string' ? item.viewer : null;
    const csrfToken = typeof item.csrfToken === 'string' ? item.csrfToken : null;
    const credential =
      typeof item.credential === 'string' && /^[A-Za-z0-9_-]{1,6400}$/.test(item.credential) ? item.credential : null;
    const originLifetime =
      typeof item.originLifetime === 'string' && item.originLifetime.length >= 1 && item.originLifetime.length <= 192
        ? item.originLifetime
        : null;
    const entryGuard = sourceEntryGuard(item.entryGuard);
    if (
      !id ||
      !privacy ||
      !sourceCreated ||
      !sourceUpdated ||
      !provider ||
      !recordId ||
      !Number.isSafeInteger(bodyInput.revision) ||
      (bodyInput.revision as number) < 1 ||
      bodyInput.confirmReviewed !== true ||
      !key ||
      !viewer ||
      !csrfToken ||
      !credential ||
      !originLifetime ||
      !entryGuard ||
      (privacy.op === 'unchanged' && sourceCreated.op === 'unchanged' && sourceUpdated.op === 'unchanged')
    )
      throw new Error('Invalid source correction');
    const body: PersonalEntrySourceCorrection = {
      provider,
      recordId,
      revision: bodyInput.revision as number,
      confirmReviewed: true,
      privacy,
      sourceCreated,
      sourceUpdated,
    };
    return {
      subjectId: id,
      body,
      key,
      viewer,
      csrfToken,
      credential,
      originLifetime,
      entryGuard,
    };
  })
  .handler(async ({ data }): Promise<SourceCorrectionCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const session = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
    if (session.state === 'unavailable') return { kind: 'unavailable' };
    if (session.state !== 'signed-in' || !session.csrfToken) return { kind: 'signed-out' };
    const identity = { viewer: session.subject, csrfToken: session.csrfToken, authorization: session.authorization };
    if (!expectedSession(data, identity)) return { kind: 'signed-out' };
    const authorization = await originalAnnotationCredential(
      getRequest(),
      env as Partial<SessionEnv>,
      identity,
      data,
    );
    if (!authorization) return { kind: 'retired' };
    try {
      const result = await correctPrivateSourceObservation(kernelClient(), {
        subjectId: data.subjectId,
        body: data.body,
        key: data.key,
        authorization,
      });
      if (result.kind !== 'saved') return result;
      const refreshed = await readPrivateEntry(kernelClient(), data.subjectId, authorization);
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
