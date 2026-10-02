import { isDeepStrictEqual } from 'node:util';

type RecordValue = Record<string, unknown>;
export interface PutRecovery {
  body: RecordValue;
  matches: boolean;
  result: RecordValue;
}
export type SeedRead = (path: string, authenticated: boolean) => Promise<RecordValue>;
const record = (value: unknown): RecordValue => value as RecordValue;
const native = (id: string) => `https://rezics.com/id/${id}`;
const sameFields = (planned: RecordValue, current: RecordValue) => Object.entries(planned)
  .every(([key, value]) => isDeepStrictEqual(value, current[key]));
const facts = (body: RecordValue) => Object.fromEntries(Object.entries(body).filter(([key]) =>
  !['profile', 'actingSubject', 'expectedHead', 'expectedHandle', 'expectedVersion',
    'expectedRevision', 'expectedGeneration', 'expectedRulesRevision', 'reason'].includes(key)));

/** Some owners use one conflict code for both a stale head and a reused key. */
export function seedPutConflict(path: string, code: string): boolean {
  if (code === 'idempotency_conflict' || code.endsWith('_basis_changed')
    || code.startsWith('stale_') || code === 'head_conflict') return true;
  const owners: Record<string, RegExp> = {
    agent_profile_conflict: /^\/v1\/agents\/[^/]+\/profile$/,
    library_visibility_conflict: /^\/v1\/agents\/[^/]+\/library-visibility$/,
    reader_status_conflict: /^\/v1\/works\/[^/]+\/reader-status$/,
    progress_conflict: /^\/v1\/compositions\/[^/]+\/occurrences\/[^/]+\/progress$/,
    review_conflict: /^\/v1\/reviews\/[^/]+\/helpful$/,
    home_conflict: /^\/v1\/me\/feed-watermarks\/[^/]+$/,
  };
  return owners[code]?.test(path) ?? false;
}

/** Only seed-owned PUTs have an automatic reconciliation policy. Reads differ
 * from writes (release coverage, reader-state, localized Realm headers), so
 * never guess a head from an arbitrary response or retry an unrelated conflict.
 * PUT retry semantics: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2 */
export async function recoverSeedPut(path: string, input: unknown, read: SeedRead,
  conflict: RecordValue): Promise<PutRecovery | null> {
  const body = record(input);
  const actor = body.actingSubject;
  const query = (route: string) => `${route}?${new URLSearchParams({ actingSubject: String(actor) })}`;
  const refreshed = (current: RecordValue, basis: RecordValue, planned = facts(body), state = current,
    result = current): PutRecovery => ({ body: { ...body, ...basis }, matches: sameFields(planned, state),
      result: { ...result, replayed: true } });

  const release = path.match(/^\/v1\/works\/([^/]+)\/releases\/([^/]+)$/);
  if (release) {
    const current = await read(query(path), true);
    const planned = facts(body);
    // Evidence is write-only. All demo releases use null; a non-null change
    // cannot be certified by this read and must pass through the command.
    if (planned.evidence === null) delete planned.evidence;
    const state = { ...current, coverage: body.profile === 'release-v1' ? current.legacyCoverage
      : (current.coverage as RecordValue[]).map(row => Object.fromEntries(
        Object.entries(row).filter(([key]) => ['realization', 'revision', 'completeness', 'portion'].includes(key)))) };
    return refreshed(current, { expectedHead: current.revision }, planned, state,
      { ...current, work: native(release[1]!), release: current.id });
  }
  const realization = path.match(/^\/v1\/works\/([^/]+)\/realizations\/([^/]+)$/);
  if (realization) {
    const current = await read(query(path), true);
    return refreshed(current, { expectedHead: current.revision }, facts(body), current,
      { ...current, realization: current.id });
  }
  if (/^\/v1\/works\/[^/]+\/metadata$/.test(path)) {
    const current = await read(query(path), true);
    const state = record(body.state);
    if (state.kind !== 'header') return null;
    return refreshed(current, { expectedHead: current.revision },
      Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'kind')));
  }
  if (/^\/v1\/works\/[^/]+\/type$/.test(path)) {
    const current = await read(query(path.slice(0, -5)), true);
    const matches = isDeepStrictEqual([...(body.types as string[])].sort(),
      [...(current.types as string[])].sort());
    return { ...refreshed(current, { expectedHead: current.revision }), matches };
  }
  if (/^\/v1\/agents\/[^/]+\/profile$/.test(path)) {
    const current = await read(path.slice(0, -8), false);
    const planned = facts(body);
    if ('localizedName' in planned) {
      planned.localizedNames = planned.localizedName;
      delete planned.localizedName;
    }
    return refreshed(current, { expectedHead: current.revision }, planned,
      { ...current, displayName: current.originalDisplayName ?? current.displayName });
  }
  if (/^\/v1\/agents\/[^/]+\/library-visibility$/.test(path)) {
    const current = await read(path, true);
    return refreshed(current, { expectedVersion: current.version });
  }
  if (/^\/v1\/works\/[^/]+\/reader-status$/.test(path)) {
    const current = record((await read(query(path.replace(/reader-status$/, 'reader-state')), true)).status);
    return refreshed(current, { expectedVersion: current.version });
  }
  if (/^\/v1\/compositions\/[^/]+\/occurrences\/[^/]+\/progress$/.test(path)) {
    const route = body.selectedRevision ? `${query(path)}&${new URLSearchParams({ selectedRevision: String(body.selectedRevision) })}`
      : query(path);
    const current = await read(route, true);
    return refreshed(current, { expectedVersion: current.version });
  }
  if (/^\/v1\/collections\/[^/]+\/name$/.test(path)) {
    const current = await read(query(path), true);
    return refreshed(current, { expectedHead: current.revision });
  }
  if (/^\/v1\/zones\/[^/]+\/configuration$/.test(path)) {
    const current = await read(query(path), true);
    return refreshed(current, { expectedHead: current.revision }, facts(body),
      { ...record(current.configuration), name: current.name, language: current.language });
  }
  if (/^\/v1\/realms\/[^/]+\/settings$/.test(path)) {
    const current = await read(query(path), true);
    return refreshed(current, { expectedGeneration: current.generation,
      expectedRulesRevision: record(current.ruleBasis).revision });
  }
  if (/^\/v1\/reviews\/[^/]+\/helpful$/.test(path)) {
    const current = await read(query(path.slice(0, -8)), true);
    return refreshed(current, { expectedRevision: current.viewerVoteRevision },
      { helpful: body.helpful }, { helpful: current.viewerHelpful },
      { ...current, review: current.id, revision: current.viewerVoteRevision, helpful: current.viewerHelpful });
  }
  if (/^\/v1\/me\/feed-watermarks\/[^/]+$/.test(path)) {
    const current = await read(query('/v1/me/feed-watermarks'), true);
    const watermark = (current.items as RecordValue[]).find(row => row.scope === body.scope);
    return refreshed(watermark ?? {}, {});
  }
  const choice = path.match(/^(\/v1\/realms\/[^/]+)\/moderators\/([^/]+)\/public-choice$/);
  if (choice) {
    const current = await read(query(choice[1]!), true);
    // A listed public moderator proves acceptance. Absence does not prove a
    // private choice, and the choice head is available only in a stale refusal.
    const matches = body.public === true
      && (record(current.moderators).items as string[]).includes(native(choice[2]!));
    if (!matches && !('currentHead' in conflict)) return null;
    return { body: { ...body, expectedHead: conflict.currentHead ?? body.expectedHead }, matches,
      result: { realm: current.id, agent: native(choice[2]!), replayed: true } };
  }
  if (/^\/v1\/realms\/[^/]+\/profile$/.test(path)) {
    const route = path.slice(0, -8);
    const current = await read(query(route), true);
    const publication = record(body.publication);
    const count = record(record(current.membership).count);
    let matches = !!current.profileRevision
      && (!body.profile || current.profileContract === body.profile)
      && sameFields({ moderators: publication.moderators }, { moderators: record(current.moderators).items })
      && record(publication.count).kind === count.kind
      && (count.kind === 'exact' || record(publication.count).value === count.value)
      && (record(current.icon).selection ?? null) === publication.iconSelection
      && (current.banner ? record(current.banner).selection : null) === publication.bannerSelection;
    const name = record(publication.name);
    if (current.originalName) matches &&= record(current.originalName).language === name.original
      && record(current.originalName).value === record(name.labels)[String(name.original)];
    // Headers select one display language. Check every authored label, including
    // rule bodies, instead of equating a matching English title with the plan.
    const rules = publication.rules as RecordValue[];
    const fields = [record(publication.name), record(publication.description),
      ...rules.flatMap(rule => [record(rule.title), record(rule.body)])];
    const languages = new Set(fields.flatMap(field => Object.keys(record(field.labels))));
    for (const language of languages) {
      const localized = await read(`${query(route)}&language=${encodeURIComponent(language)}`, true);
      if (localized.profileRevision !== current.profileRevision) return null;
      const equalLabel = (planned: unknown, shown: unknown) => {
        const label = record(record(planned).labels)[language];
        return label === undefined || !!shown && record(shown).value === label && record(shown).language === language;
      };
      const shownRules = localized.rules as RecordValue[] | null;
      matches &&= equalLabel(publication.name, localized.name)
        && equalLabel(publication.description, localized.description)
        && !!shownRules && shownRules.length === rules.length && rules.every((rule, index) => {
          const shown = shownRules[index]!;
          return rule.id === shown.id && equalLabel(rule.title, shown.title)
            && equalLabel(rule.body, shown.body) && isDeepStrictEqual(rule.governanceRule, shown.governanceRule);
        });
    }
    // replyPolicy has no read representation. Do not certify a requested change.
    if ('replyPolicy' in publication) matches = false;
    return { ...refreshed(current, { expectedHead: current.profileRevision }), matches };
  }
  return null;
}
