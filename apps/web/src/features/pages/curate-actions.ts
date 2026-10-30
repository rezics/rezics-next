import { platformRegistry, validateProfile, type PresentationProfile } from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { curationFailure, publishProfile, type CurationFailure, type PublishInput, type PublishResult } from './curate';
import { pickText } from '@rezics/composition';
import { readRelease } from '../../subject/definitions';
import {
  readCandidates,
  selectCandidate,
  type CandidateCommand,
  type CandidateSlot,
  type CandidateSelection,
  type CandidateRead,
  type CandidateResult,
} from '../../subject/candidates';

export type CurationRead =
  | { ok: true; digest: string; head: number; profile: PresentationProfile }
  | { ok: false; reason: 'signed-out' }
  | CurationFailure;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;

function validateInput(input: unknown): PublishInput | CurationFailure {
  if (
    !input ||
    typeof input !== 'object' ||
    !('profile' in input) ||
    !('expectedHead' in input) ||
    !Number.isSafeInteger(input.expectedHead) ||
    (input.expectedHead as number) < 0 ||
    !('keys' in input) ||
    !input.keys ||
    typeof input.keys !== 'object' ||
    !('publish' in input.keys) ||
    typeof input.keys.publish !== 'string' ||
    !uuid.test(input.keys.publish) ||
    !('activate' in input.keys) ||
    typeof input.keys.activate !== 'string' ||
    !uuid.test(input.keys.activate) ||
    input.keys.publish === input.keys.activate
  )
    throw new Error('Invalid curation request');
  const errors = validateProfile(platformRegistry, input.profile);
  if (errors.length > 0) return { ok: false, reason: 'invalid', errors };
  return {
    profile: input.profile as PresentationProfile,
    expectedHead: input.expectedHead as number,
    keys: { publish: input.keys.publish, activate: input.keys.activate },
  };
}

async function sessionBearer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}

// POST server functions use the site's origin and session-token CSRF middleware.
// Composition props are typed as unknown; validateProfile checks their JSON shape.
export const readCuration = createServerFn({ method: 'POST', strict: false })
  .validator(() => undefined)
  .handler(async (): Promise<CurationRead> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'signed-out' };
    try {
      const client = kernelClient();
      const active = await client.presentation.active.get({ headers: { authorization } });
      if (active.status >= 400) return curationFailure(active.status, active.error?.value, active.headers);
      if (!active.data) return { ok: false, reason: 'unavailable' };
      const result = await client.presentation
        .profiles({ digest: active.data.digest })
        .get({ headers: { authorization } });
      if (result.status >= 400) return curationFailure(result.status, result.error?.value, result.headers);
      if (!result.data || validateProfile(platformRegistry, result.data.profile).length > 0)
        return { ok: false, reason: 'unavailable' };
      return { ok: true, ...active.data, profile: result.data.profile as PresentationProfile };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const publishCuration = createServerFn({ method: 'POST' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<PublishResult> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'forbidden' };
    if ('ok' in data) return data;
    return publishProfile(kernelClient(), { ...data, authorization });
  });

function candidateAddress(input: unknown) {
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string' || !uuid.test(input.id))
    throw new Error('Invalid subject');
  const value = input as Record<string, unknown>;
  if (
    value.property !== undefined &&
    (typeof value.property !== 'string' || !value.property || value.property.length > 256)
  )
    throw new Error('Invalid field');
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 8192))
    throw new Error('Invalid continuation');
  let slot: CandidateSlot | undefined;
  if (value.slot !== undefined) {
    if (!value.slot || typeof value.slot !== 'object' || Array.isArray(value.slot)) throw new Error('Invalid slot');
    const address = value.slot as Record<string, unknown>;
    if (
      Object.keys(address).some((key) => !['target', 'sameAs', 'key'].includes(key)) ||
      (address.target !== undefined && (typeof address.target !== 'string' || !uuid.test(address.target))) ||
      (address.sameAs !== undefined &&
        (typeof address.sameAs !== 'string' ||
          address.sameAs.length > 8192 ||
          !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(address.sameAs))) ||
      (address.target !== undefined && address.sameAs !== undefined) ||
      (address.key !== undefined && (typeof address.key !== 'string' || !uuid.test(address.key) || !address.target))
    )
      throw new Error('Invalid slot');
    slot = address as CandidateSlot;
  }
  if (value.session !== undefined && (typeof value.session !== 'string' || value.session.length > 8192))
    throw new Error('Invalid session continuity');
  return {
    id: input.id,
    property: value.property as string | undefined,
    cursor: value.cursor as string | undefined,
    ...(slot ? { slot } : {}),
    ...(typeof value.session === 'string' ? { session: value.session } : {}),
  };
}

// Candidate data is an explicitly opened, session-scoped region, never part of public SSR or its query cache.
export const readSubjectCandidates = createServerFn({ method: 'POST', strict: false })
  .validator(candidateAddress)
  .handler(async ({ data }): Promise<CandidateRead> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'denied' };
    try {
      const locale = (await import('../../kernel/client')).requestLocale() ?? 'en';
      const [release, result] = await Promise.all([
        readRelease(),
        readCandidates(kernelClient(), authorization, data.id, data.property, data.cursor, data.slot, data.session),
      ]);
      if (!result.ok) return result;
      // Relation slots require a target address; this picker lists descriptive property slots only.
      const admitted = new Set(release.types[result.public.subject.type]?.properties ?? []);
      const fields = Object.entries(release.properties)
        .flatMap(([id, definition]) => {
          if (!admitted.has(id)) return [];
          if (!data.slot && definition.relation && definition.relation.group !== 'classification') return [];
          const label = pickText(definition.labels ?? {}, locale).text;
          return label ? [{ id, label, multivalued: definition.multivalued === true }] : [];
        })
        .sort((a, b) => a.label.localeCompare(b.label, locale));
      if (data.property && !fields.some((field) => field.id === data.property))
        return { ok: false, reason: 'unavailable' };
      return {
        ...result,
        fields,
        names: Object.fromEntries(Object.entries(release.properties).map(([id, value]) => [id, value.labels ?? {}])),
      };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const confirmSubjectCandidate = createServerFn({ method: 'POST', strict: false })
  .validator((input: unknown): CandidateCommand => {
    const address = candidateAddress(input);
    const value = input as Record<string, unknown>;
    if (
      !address.property ||
      typeof value.candidate !== 'string' ||
      !uuid.test(value.candidate) ||
      typeof value.key !== 'string' ||
      !uuid.test(value.key) ||
      (value.operation !== 'accept' && value.operation !== 'reject' && value.operation !== 'adopt') ||
      (value.head !== null && (!Number.isSafeInteger(value.head) || Number(value.head) < 1))
    )
      throw new Error('Invalid candidate confirmation');
    let selection: CandidateSelection[] | undefined;
    if (value.selection !== undefined) {
      if (value.operation !== 'adopt' || !Array.isArray(value.selection) || value.selection.length > 32)
        throw new Error('Invalid selection');
      selection = value.selection.map((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !('candidate' in entry) ||
          typeof entry.candidate !== 'string' ||
          !uuid.test(entry.candidate) ||
          !('rank' in entry) ||
          (entry.rank !== 'normal' && entry.rank !== 'preferred')
        )
          throw new Error('Invalid selected value or rank');
        return { candidate: entry.candidate, rank: entry.rank };
      });
      if (new Set(selection.map((entry) => entry.candidate)).size !== selection.length)
        throw new Error('Duplicate selected value');
    }
    if (value.rank !== undefined && value.rank !== 'normal' && value.rank !== 'preferred')
      throw new Error('Invalid rank');
    return {
      id: address.id,
      property: address.property,
      candidate: value.candidate,
      operation: value.operation,
      head: value.head as number | null,
      key: value.key,
      ...(address.slot ? { slot: address.slot } : {}),
      ...(address.session ? { session: address.session } : {}),
      ...(selection ? { selection } : {}),
      ...(value.rank === 'normal' || value.rank === 'preferred' ? { rank: value.rank } : {}),
    };
  })
  .handler(async ({ data }): Promise<CandidateResult> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'denied' };
    return selectCandidate(kernelClient(), authorization, data);
  });
