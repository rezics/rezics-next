import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import {
  initialTerms,
  type CreateSubjectCommand,
  type CreateResult,
  type CreatedReader,
  type InitialSubject,
  type TermDraft,
} from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { type EditorRead, type StatementInput } from './statement-editor';
import { gameDraft, gameFields, gameTarget } from './game-profile';

export const addonType = 'wd:Q209163';
export const addonBase = 'wdt:P8646';
export const addonUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type AddonAddress = { id?: string | undefined; work?: string | undefined };
export type AddonRead =
  | { ok: false; reason: 'invalid' | 'denied' | 'stale' | 'unavailable' }
  | {
      ok: true;
      release: Release;
      public: SubjectRead | null;
      /** A readable, admitted page-context suggestion. It is never an assertion. */
      work: SubjectRead | null;
      workId?: string | undefined;
      workIssue?: 'denied' | 'invalid' | 'stale' | 'unavailable' | undefined;
    };
export type AddonTransport = {
  load: (address: AddonAddress) => Promise<AddonRead>;
  create: (command: CreateSubjectCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
};

/** Presentation intersects the active native profile; it never publishes a profile or changes Library behavior. */
export function addonFields(release: Release): string[] {
  return gameFields(release, addonType);
}
export function addonTarget(release: Release, property: string, type: string): boolean {
  return gameTarget(release, property, type);
}
export function addonFacts(read: Extract<AddonRead, { ok: true }>): EditorRead {
  return read.public
    ? { ok: true, public: read.public, release: read.release, source: null }
    : { ok: false, reason: 'invalid' };
}
export async function readAddonProfile(client: KernelClient, address: AddonAddress): Promise<AddonRead> {
  if ([address.id, address.work].some((id) => id !== undefined && !addonUuid.test(id)))
    return { ok: false, reason: 'invalid' };
  try {
    const [active, subject, work] = await Promise.all([
      client.definitions.active.get(),
      address.id ? client.subjects({ id: address.id }).get() : undefined,
      address.work ? client.subjects({ id: address.work }).get() : undefined,
    ]);
    if (address.id) {
      if (subject?.status === 403 || subject?.status === 404) return { ok: false, reason: 'denied' };
      if (subject?.status === 308 || (subject?.data && subject.data.subject.id !== address.id))
        return { ok: false, reason: 'stale' };
      if (subject?.status !== 200 || !subject.data) return { ok: false, reason: 'unavailable' };
    }
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types?.[addonType] || !release.properties) return { ok: false, reason: 'unavailable' };
    if (subject?.data && subject.data.subject.type !== addonType) return { ok: false, reason: 'invalid' };
    let workIssue: Extract<AddonRead, { ok: true }>['workIssue'];
    let suggestedWork: SubjectRead | null = null;
    if (address.work) {
      if (work?.status === 403 || work?.status === 404) workIssue = 'denied';
      else if (work?.status === 308 || (work?.data && work.data.subject.id !== address.work)) workIssue = 'stale';
      else if (work?.status !== 200 || !work.data) workIssue = 'unavailable';
      else {
        suggestedWork = work.data;
        if (!addonTarget(release, addonBase, work.data.subject.type)) workIssue = 'invalid';
      }
    }
    return {
      ok: true,
      release,
      public: subject?.data ?? null,
      work: suggestedWork,
      ...(address.work ? { workId: address.work, workIssue } : {}),
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
export function validateAddon(release: Release, item: CreateSubjectCommand['item']): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (item.type !== addonType) errors.push({ pointer: '/type', code: 'unsupported' });
  return errors;
}
export function addonDraft(release: Release, terms: TermDraft[], facts: StatementInput[]) {
  const initial = initialTerms(addonType, terms);
  const draft = addonInitialDraft(release, initial.item, facts);
  return { item: draft.item, errors: [...initial.errors, ...draft.errors] };
}
export function addonInitialDraft(release: Release, initial: InitialSubject, facts: StatementInput[]) {
  const draft = gameDraft(release, initial, facts);
  if (initial.type !== addonType) draft.errors.push({ pointer: '/type', code: 'unsupported' });
  return draft;
}
export async function createAddon(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: CreateSubjectCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readAddonProfile(client, {});
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const errors = validateAddon(read.release, command.item);
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, env, command, locale, preparedAuthorization);
}
