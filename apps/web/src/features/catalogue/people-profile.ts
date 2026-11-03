import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { candidateFailure, type CandidateFailure } from '../../subject/candidates';
import { DefinitionReadError, definitionText, fetchGuideRelease } from './definition-guide';
import { createSubjectRecord } from './create-subject-request';
import type { CreateResult, CreatedReader, InitialSubject } from './create-subject';
import { correctionProperty, creationStatement, type StatementInput } from './statement-editor';
import { peopleBiographyGroups } from './people-biography';

export { peopleAgentType, peopleBiographyGroups, peopleScalarFields } from './people-biography';

export const peopleUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PeopleAddress = { id?: string; work?: string };
export type PeopleProfile = {
  id: string;
  label: string;
  lang: string | null;
  description: string;
  descriptionLang: string | null;
  fields: string[];
  relations: string[];
  unsupported: string[];
};
export type PeopleRead =
  | CandidateFailure
  | {
      ok: true;
      release: Release;
      public: SubjectRead | null;
      work: SubjectRead | null;
      profiles: PeopleProfile[];
      credits: string[];
    };
export type PeopleItem = InitialSubject & { statements?: Record<string, StatementInput[]> };
export type PeopleCommand = { key: string; item: PeopleItem };
export type PeopleTransport = {
  load: () => Promise<PeopleRead>;
  create: (command: PeopleCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
};

async function profileRelease(client: KernelClient): Promise<Release> {
  // The shared guide retains the native release and adds its digest. Remove that presentation-only member.
  const { digest: _digest, ...release } = await fetchGuideRelease(client);
  return release as Release;
}

/** The two released agent grains, with their effective fields; never an account or software-agent editor. */
export function peopleProfiles(release: Release, locale: string): PeopleProfile[] {
  return ['schema:Person', 'schema:Organization'].flatMap((id) => {
    const type = release.types[id];
    const label = definitionText(type?.labels, locale);
    if (!type || !label.text) return [];
    const description = definitionText(type.descriptions, locale);
    const fields = type.properties.filter((property) => correctionProperty(release, id, property));
    const relations = type.properties.filter((property) => !!release.properties[property]?.relation);
    const grouped = new Set(
      peopleBiographyGroups(release, id, locale)
        .flatMap((group) => group.fields)
        .filter((field) => field.editor !== 'none')
        .map((field) => field.id),
    );
    return [
      {
        id,
        label: label.text,
        lang: label.lang,
        description: description.text,
        descriptionLang: description.lang,
        fields,
        relations,
        unsupported: type.properties.filter(
          (property) =>
            property !== 'schema:name' &&
            !fields.includes(property) &&
            !relations.includes(property) &&
            !grouped.has(property),
        ),
      },
    ];
  });
}

export function peopleCreditProperties(release: Release, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((id) => {
    const property = release.properties[id];
    return (
      property?.relation?.group === 'credit' &&
      property.targets?.some((target) =>
        ['schema:Person', 'schema:Organization'].some(
          (agent) => agent === target || release.types[agent]?.bases.includes(target),
        ),
      )
    );
  });
}

/** One current subject read and one shared release read, in parallel. Related summaries need no row hydration. */
export async function readPeopleProfile(
  client: KernelClient,
  locale: string,
  address: PeopleAddress = {},
): Promise<PeopleRead> {
  const id = address.id ?? address.work;
  if ((id !== undefined && !peopleUuid.test(id)) || (address.id && address.work))
    return { ok: false, reason: 'invalid' };
  try {
    const [release, response] = await Promise.all([
      profileRelease(client),
      id ? client.subjects({ id }).get() : Promise.resolve(null),
    ]);
    if (response && (response.status !== 200 || !response.data)) return candidateFailure(response.status);
    if (response && response.data?.subject.id !== id) return { ok: false, reason: 'stale' };
    const profiles = peopleProfiles(release, locale);
    const current = response?.data ?? null;
    if (address.id && !profiles.some((profile) => profile.id === current?.subject.type))
      return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      release,
      profiles,
      public: address.id ? current : null,
      work: address.work ? current : null,
      credits: address.work && current ? peopleCreditProperties(release, current.subject.type) : [],
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DefinitionReadError && error.reason === 'invalid'
          ? 'stale'
          : error instanceof DefinitionReadError && error.reason === 'denied'
            ? 'denied'
            : 'unavailable',
    };
  }
}

/** Initial facts are optional, explicit native statements. Terms stay separate from schema:name. */
export function peopleInitialItem(initial: InitialSubject, facts: Record<string, StatementInput>): PeopleItem {
  const entries: [string, StatementInput[]][] = Object.entries(facts).map(([id, fact]) => [
    id,
    [structuredClone(creationStatement(fact, { properties: {} } as Release))],
  ]);
  return {
    ...initial,
    ...(entries.length ? { statements: Object.fromEntries(entries) } : {}),
  };
}

export function validatePeopleItem(item: PeopleItem, release: Release): Violation[] {
  const errors = checkSubjectInput(item, release).violations;
  const profile = peopleProfiles(release, 'en').find((entry) => entry.id === item.type);
  if (!profile) errors.push({ pointer: '/type', code: 'unsupported' });
  for (const property of Object.keys(item.statements ?? {})) {
    if (!profile?.fields.includes(property))
      errors.push({
        pointer: `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        code: 'unsupported',
      });
  }
  return errors;
}

/** Current native personal/disclosure/target eligibility is rechecked by the ordinary writer. */
export async function createPeopleProfile(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: PeopleCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  try {
    const release = await profileRelease(client);
    const errors = validatePeopleItem(command.item, release);
    if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
    return createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
