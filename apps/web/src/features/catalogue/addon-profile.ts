import type { KernelClient } from '@rezics/client';
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
      public: Extract<EditorRead, { ok: true }>['public'] | null;
      work: Extract<EditorRead, { ok: true }>['public'] | null;
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
    for (const [result, id] of [
      [subject, address.id],
      [work, address.work],
    ] as const) {
      if (!id) continue;
      if (result?.status === 403 || result?.status === 404) return { ok: false, reason: 'denied' };
      if (result?.status === 308 || (result?.data && result.data.subject.id !== id))
        return { ok: false, reason: 'stale' };
      if (result?.status !== 200 || !result.data) return { ok: false, reason: 'unavailable' };
    }
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types?.[addonType] || !release.properties) return { ok: false, reason: 'unavailable' };
    if (
      (subject?.data && subject.data.subject.type !== addonType) ||
      (work?.data && !addonTarget(release, addonBase, work.data.subject.type))
    )
      return { ok: false, reason: 'invalid' };
    return { ok: true, release, public: subject?.data ?? null, work: work?.data ?? null };
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
): Promise<CreateResult> {
  const read = await readAddonProfile(client, {});
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const errors = validateAddon(read.release, command.item);
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, env, command, locale);
}
