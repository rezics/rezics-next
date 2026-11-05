import { createKernelClient, type SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { releaseDigest, type Release } from '@rezics/definitions';
import emitted from '../../../../../packages/definitions/release/rezics.json';
import {
  addonBase,
  addonFacts,
  addonType,
  createAddon,
  readAddonProfile,
} from '../../features/catalogue/addon-profile';
import type { AddonProfileProps } from '../../features/catalogue/addon-profile-view';
import type { StatementInput } from '../../features/catalogue/statement-editor';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import { relationDescriptorReader } from './relation-descriptor';
import {
  readRelationEditor,
  proposeRelation,
  confirmRelation,
  relationFields,
  relationSlotMatches,
  type RelationSlot,
} from '../../subject/relation-candidates';

export const addonProfileId = '00000000-0000-4000-8000-00000000a001';
export const addonCreatedId = '00000000-0000-4000-8000-00000000a002';
export const addonWorkId = '00000000-0000-4000-8000-00000000a003';
export const addonCreatorId = '00000000-0000-4000-8000-00000000a004';
export const addonPlatformId = '00000000-0000-4000-8000-00000000a005';
export type AddonScenario =
  | 'ready'
  | 'loading'
  | 'signed-out'
  | 'denied'
  | 'unavailable'
  | 'invalid'
  | 'stale'
  | 'uncertain'
  | 'reader-unavailable'
  | 'concealed'
  | 'pending'
  | 'partial';

/** Synthetic request responses through production adapters; no native or visual evidence is implied. */
export function addonProfileFixture(scenario: AddonScenario = 'ready', locale = 'en') {
  const release = emitted as unknown as Release;
  const digest = releaseDigest(release);
  let serial = 100;
  const readSnak = (part: NonNullable<StatementInput['qualifiers']>[number]) => ({
    ...part,
    property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
  });
  const readStatement = (statement: StatementInput): Candidate['statement'] => ({
    ...readSnak(statement),
    id: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    rank: statement.rank ?? 'normal',
    qualifiers: (statement.qualifiers ?? []).map(readSnak),
    references: statement.references.map(({ parts }) => ({ hash: 'citation', parts: parts.map(readSnak) })),
    rezics: { release: digest, revision: 1 },
  });
  const assertion = (property: string, content: string): StatementInput => ({
    property: { id: property },
    value: { type: 'value', content },
    qualifiers: [],
    references: [],
  });
  const empty = (id: string, type: string, labels: Record<string, string>): SubjectRead => ({
    subject: {
      id,
      type,
      context: candidateContext,
      revision: 1,
      release: digest,
      labels,
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    summary: null,
    related: {},
  });
  const current = empty(addonProfileId, addonType, { en: 'Harbor: Northern lights', ja: '港：北の光' });
  const work = empty(addonWorkId, 'schema:VideoGame', { en: 'Harbor', ja: '港' });
  const creator = empty(addonCreatorId, 'schema:Organization', { en: 'Harbor Studio' });
  const platform = empty(addonPlatformId, 'skos:Concept', { en: 'Desktop platform' });
  current.subject.statements[addonBase] = [readStatement(assertion(addonBase, addonWorkId))];
  current.subject.statements['schema:inLanguage'] = [readStatement(assertion('schema:inLanguage', 'ja'))];
  // Deliberately distinct base facts must never enter the add-on draft or current read.
  work.subject.statements['schema:inLanguage'] = [readStatement(assertion('schema:inLanguage', 'en'))];
  work.subject.statements['wdt:P178'] = [readStatement(assertion('wdt:P178', addonCreatorId))];
  for (const item of [work, creator, platform])
    current.related[item.subject.id] = {
      type: item.subject.type,
      labels: item.subject.labels,
    };
  const calls: { path: string; query: string; method: string; body: unknown; key: string | null }[] = [];
  const candidates: Candidate[] = [];
  const receipts = new Map<string, { body: unknown; status: number }>();
  let created = empty(addonCreatedId, addonType, {});
  let lost = false;
  let head = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'addon-session' },
    });
  const matches = (statement: Candidate['statement'], slot: RelationSlot) => {
    const field = relationFields(release, addonType, locale).find((field) => field.id === slot.property);
    return statement.property.id === slot.property && (!field || relationSlotMatches(statement, slot, field));
  };
  const client = createKernelClient('https://addon.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const key = request.headers.get('idempotency-key');
      const body = request.method === 'POST' ? await request.json() : null;
      calls.push({ path, query: url.search, method: request.method, body, key });
      if (path === '/v1/definitions/active') {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        return scenario === 'unavailable' ? json({}, 503) : json({ digest, head: 1 });
      }
      if (path.startsWith('/v1/definitions/releases/'))
        return json({ digest: scenario === 'stale' ? 'sha256:stale' : digest, release });
      if (request.method === 'GET' && path === `/v1/subjects/${addonCreatedId}`)
        return scenario === 'concealed'
          ? json({}, 404)
          : scenario === 'reader-unavailable'
            ? json({}, 503)
            : json(created);
      if (request.method === 'GET' && path === `/v1/subjects/${addonProfileId}`)
        return scenario === 'denied' ? json({}, 403) : json(current);
      for (const item of [work, creator, platform])
        if (request.method === 'GET' && path === `/v1/subjects/${item.subject.id}`) return json(item);
      if (request.method === 'GET' && path === `/v1/subjects/${addonProfileId}/candidates`) {
        const property = url.searchParams.get('property')!;
        const target = url.searchParams.get('target');
        const slot = {
          property,
          ...(target ? { target } : {}),
          ...(url.searchParams.get('key') ? { key: url.searchParams.get('key')! } : {}),
        };
        return json({
          candidates: candidates.filter((candidate) =>
            target ? matches(candidate.statement, slot) : candidate.statement.property.id === property,
          ),
          adoption: { mode: 'replace', head: head || null },
          next: null,
        });
      }
      if (request.method !== 'POST') return json({}, 503);
      const inputStatement = (body as { statement?: StatementInput } | null)?.statement;
      if (scenario === 'denied' || (scenario === 'partial' && inputStatement?.property.id === 'schema:inLanguage'))
        return json({}, 403);
      if (scenario === 'invalid') return json({ errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }, 400);
      if (key && receipts.has(key)) {
        const receipt = receipts.get(key)!;
        return json(receipt.body, receipt.status);
      }
      let result: unknown;
      let status = 200;
      if (path === '/v1/subjects') {
        const item = body as {
          labels: Record<string, string>;
          descriptions: Record<string, string>;
          aliases: Record<string, string[]>;
          statements?: Record<string, StatementInput[]>;
        };
        created = empty(addonCreatedId, addonType, item.labels);
        created.subject.descriptions = item.descriptions;
        created.subject.aliases = item.aliases;
        created.subject.statements = Object.fromEntries(
          Object.entries(item.statements ?? {}).map(([property, statements]) => [
            property,
            statements.map(readStatement),
          ]),
        );
        result = { subject: created.subject };
        status = 201;
      } else if (path === `/v1/subjects/${addonProfileId}/candidates`) {
        const statement = readStatement(inputStatement!);
        candidates.push({
          id: statement.id,
          source: null,
          release: digest,
          revision: 2,
          retracted: null,
          retraction: null,
          decision: null,
          head: null,
          rank: null,
          statement,
        });
        result = { candidate: statement.id, revision: 2 };
        status = 201;
      } else if (path.endsWith(':accept') || path.endsWith(':reject')) {
        const candidate = candidates.find((candidate) => path.includes(candidate.id));
        const decision = body as { expected_head: number | null };
        if (!candidate || decision.expected_head !== candidate.head) return json({ code: 'stale_editorial_head' }, 409);
        candidate.decision = path.endsWith(':accept') ? 'accepted' : 'rejected';
        candidate.head = (candidate.head ?? 0) + 1;
        result = {
          acceptance: {
            context: candidateContext,
            candidate: candidate.id,
            decision: candidate.decision === 'accepted' ? 'accept' : 'reject',
            head: candidate.head,
          },
          revision: 3,
        };
      } else if (path.endsWith(':adopt')) {
        const adoption = body as RelationSlot & { expected_head: number | null; selection: { candidate: string }[] };
        if (adoption.expected_head !== (head || null)) return json({ code: 'stale_editorial_head' }, 409);
        const selected = candidates.filter((candidate) =>
          adoption.selection.some((entry) => entry.candidate === candidate.id),
        );
        if (scenario !== 'pending')
          current.subject.statements[adoption.property] = [
            ...(adoption.target
              ? (current.subject.statements[adoption.property] ?? []).filter(
                  (statement) => !matches(statement, adoption),
                )
              : []),
            ...selected.map((candidate) => ({ ...candidate.statement, rank: 'normal' as const })),
          ];
        result = { adoption: { ...adoption, head: ++head }, revision: 4 };
      } else return json({}, 503);
      if (key) receipts.set(key, { body: result, status });
      if (scenario === 'uncertain' && !lost) {
        lost = true;
        throw new TypeError('Response lost');
      }
      return json(result, status);
    }) as typeof fetch,
  });
  const transport: AddonProfileProps['transport'] = {
    load: (address) => readAddonProfile(client, address),
    create: (command) =>
      createAddon(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  const props: Omit<AddonProfileProps, 'locale' | 'id' | 'work'> = {
    session: scenario === 'signed-out' ? 'signed-out' : 'signed-in',
    transport,
    search: async (text) =>
      [current, work, creator, platform]
        .map((item) => ({
          id: item.subject.id,
          title: pickText(item.subject.labels, locale).text,
          types: [item.subject.type],
          typeLabel: pickText(release.types[item.subject.type]!.labels, locale).text,
          cover: null,
        }))
        .filter((entry) => entry.title.toLocaleLowerCase().includes(text.toLocaleLowerCase())),
    facts: (id) => ({
      read: async () => {
        const read = await transport.load({ id });
        return read.ok ? addonFacts(read) : read;
      },
      propose: (command) => proposeFact(client, 'Bearer fixture', command),
    }),
    review: (id, property) => ({
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_field, cursor, session) => {
        const read = await readCandidates(client, 'Bearer fixture', id, property, cursor, undefined, session);
        return read.ok
          ? {
              ...read,
              fields: [
                {
                  id: property,
                  label: pickText(release.properties[property]!.labels, locale).text,
                  multivalued: release.properties[property]!.multivalued,
                },
              ],
              names: Object.fromEntries(
                Object.entries(release.properties).map(([id, definition]) => [id, definition.labels]),
              ),
            }
          : read;
      },
      confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
    }),
    relations: (id) => ({
      read: (slot, cursor, session) =>
        readRelationEditor(
          client,
          'Bearer fixture',
          relationDescriptorReader(release),
          id,
          locale,
          slot,
          cursor,
          session,
        ),
      propose: (command) => proposeRelation(client, 'Bearer fixture', relationDescriptorReader(release), command),
      confirm: (command) => confirmRelation(client, 'Bearer fixture', command),
    }),
  };
  return { client, release, current, work, transport, props, calls, candidates };
}
