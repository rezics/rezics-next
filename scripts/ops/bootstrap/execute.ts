import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { BootstrapApi } from './api.ts';
import { BootstrapJournal, digest } from './journal.ts';
import { inside, type BootstrapPlan, type ZoneManifest } from './plan.ts';
import { seedRelationLexicon, seedVariantKindConcepts, seedCanonicity } from '../../dev/seed/relation-lexicon.ts';
import { relationLexiconSeed } from '../../dev/seed/relation-lexicon-data.ts';
import { seedScopedSubjectQuestions, scopedSubjectQuestions, scopedSubjectLocales,
  type GlobalQuestions } from '../../dev/seed/scoped-subjects-questions.ts';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import {
  operationOutcome,
  type OperationOutcome,
} from '../../../services/main/src/modules/operation/outcome.ts';

const short = (iri: string) => iri.slice(-36);
export function resource(namespace: string, name: string): string {
  const hex = digest([namespace, name]).slice(0, 32);
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export interface BootstrapResult {
  profile: 'launch-bootstrap-result-v1';
  registryDigest: string;
  outcome: OperationOutcome;
  counts: Record<string, number>;
  zones: { id: string; zone: string; realm: string; collections: Record<string, string> }[];
  definitions: { key: string; component: string; revision: string }[];
  vocabulary?: { variantKinds: Record<string, string>; canonicity: Awaited<ReturnType<typeof seedCanonicity>> };
  questions: GlobalQuestions;
  sources: {
    id: string;
    version: string;
    dumpSha256: string | null;
    sliceSha256: string | null;
    rightsEvidenceDate: string;
    steward: string;
    backup: string;
    attribution: string;
    works: { id: string; work: string; revision: string }[];
  }[];
}
interface WorkReceipt {
  work: string;
  workRevision: string;
  mainVersion: string;
  mainRevision: string;
}
interface CollectionReceipt {
  structure: string;
  revision: string;
}

export function atPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      throw new Error('Source evidence pointer is absent from the pinned slice');
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** O(zones + mounts + vocabulary labels + bounded records) sequential API calls.
 * No parallel writes, changed client identity, throttle bypass or demo material.
 * Source mapping is plan data; this executor has no provider/type branches. */
export async function executeBootstrap(input: {
  root: string;
  plan: BootstrapPlan;
  zones: ZoneManifest[];
  api: BootstrapApi;
  journal: BootstrapJournal;
}): Promise<BootstrapResult> {
  const { root, plan, zones, api, journal } = input;
  const actor = plan.operators[0]!.actingSubject;
  if (journal.state.actor !== actor || journal.state.planDigest !== digest({ plan, zones })) {
    throw new Error('Bootstrap journal does not match the launch plan');
  }
  const registry = await api.read<{
    profile: string;
    digest: string;
    types: { type: string; base: string }[];
  }>('/v1/types', true);
  if (
    registry.profile !== 'types-v1' ||
    !/^[0-9a-f]{64}$/.test(registry.digest) ||
    registry.types.length > 128
  ) {
    throw new Error('Main did not serve an admitted type registry');
  }
  // All local provenance and registry checks precede the first API write.
  const evidence = new Map<string, unknown>();
  for (const source of plan.sources.filter((source) => source.enabled)) {
    if (!source.slice) throw new Error(`Source ${source.id} has no slice`);
    const bytes = await readFile(inside(root, source.slice));
    if (
      bytes.length > source.bounds.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== source.sliceSha256
    ) {
      throw new Error(`Source ${source.id} slice differs from its pin or byte bound`);
    }
    const slice: unknown = JSON.parse(bytes.toString('utf8'));
    for (const record of source.records) {
      const title = atPointer(slice, record.sourceTitlePointer);
      const language = atPointer(slice, record.sourceLanguagePointer);
      const id = atPointer(slice, record.sourceIdPointer);
      if (title !== record.title.value || language !== record.title.language || id !== record.id) {
        throw new Error(
          `Source ${source.id}/${record.id} mapping differs from its captured evidence`,
        );
      }
      evidence.set(`${source.id}:${record.id}`, {
        pointers: {
          [record.sourceTitlePointer]: title,
          [record.sourceLanguagePointer]: language,
          [record.sourceIdPointer]: id,
        },
        dump: { url: source.dumpUrl, version: source.version, sha256: source.dumpSha256 },
        sliceSha256: source.sliceSha256,
      });
    }
    for (const type of source.records.flatMap((record) => record.semanticTypes)) {
      if (!registry.types.some((entry) => entry.type === type && entry.base === 'work')) {
        throw new Error(`Source ${source.id} uses a type absent from Main's registry`);
      }
    }
    if (source.zones.some((id) => !zones.some((zone) => zone.id === id)))
      throw new Error(`Source ${source.id} names an absent Zone`);
  }
  const key = (label: string) => `bootstrap:${plan.namespace}:${label}`;
  const unfinished = (label: string) => {
    const entry = journal.state.entries[key(label)];
    return entry !== undefined && entry.response === undefined;
  };
  const command = <T>(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    label: string,
    intent?: unknown,
  ) => journal.command<T>(api, key(label), method, path, body, intent);
  const result: BootstrapResult = {
    profile: 'launch-bootstrap-result-v1',
    registryDigest: registry.digest,
    outcome: operationOutcome(plan.namespace, []),
    counts: {},
    zones: [],
    definitions: [],
    sources: [],
    questions: await seedScopedSubjectQuestions({
      get: path => api.read(path),
      post: (path, body, label) => journal.command(api, label, 'POST', path, body),
    }, actor, plan.namespace),
  };
  for (const spec of zones) {
    const realm = await command<{ space: string; realm: string }>(
      'POST',
      '/v1/spaces',
      {
        profile: 'space-realm-v2',
        name: spec.name,
        language: spec.language,
        handle: spec.routeSegment,
        capabilities: ['realm'],
        actingSubject: actor,
      },
      `realm:${spec.id}`,
    );
    const zone = resource(plan.namespace, `zone:${spec.id}`);
    await command(
      'POST',
      '/v1/zones',
      { zone, space: realm.space, disclosure: 'public', actingSubject: actor },
      `zone:${spec.id}`,
    );
    const mounts = spec.mounts ?? [
      { id: spec.mountSegment!, name: `${spec.name} Catalogue`, routeSegment: spec.mountSegment! },
    ];
    const collections: Record<string, string> = {};
    for (const mount of mounts) {
      const collection = resource(plan.namespace, `collection:${spec.id}:${mount.id}`);
      collections[mount.id] = collection;
      await command<CollectionReceipt>(
        'POST',
        '/v1/collections',
        {
          collection,
          name: mount.name,
          language: spec.language,
          disclosure: 'public',
          actingSubject: actor,
        },
        `collection:${spec.id}:${mount.id}`,
      );
      const page = await api.read<{
        revision: string;
        mounts: { target?: string; state?: string }[];
      }>(`/v1/zones/${short(zone)}?actingSubject=${encodeURIComponent(actor)}&limit=100`);
      if (
        unfinished(`mount:${spec.id}:${mount.id}`) ||
        !page.mounts.some((item) => item.target === collection && item.state !== 'removed')
      ) {
        await command(
          'POST',
          `/v1/zones/${short(zone)}/mounts`,
          {
            expectedHead: page.revision,
            target: collection,
            routeSegment: mount.routeSegment,
            disclosure: 'public',
            position: 'last',
            actingSubject: actor,
          },
          `mount:${spec.id}:${mount.id}`,
          { zone, collection, segment: mount.routeSegment },
        );
      }
    }
    const configuration = await api.read<{
      revision: string;
      name: string;
      language: string;
      configuration: { defaultRealm: string | null; official: unknown; presentation: unknown };
    }>(`/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(actor)}`);
    const desired = {
      name: spec.name,
      language: spec.language,
      defaultRealm: realm.realm,
      official: {},
      presentation: {
        profile: 'zone-presentation-v1',
        preset: spec.preset,
        tokens: ZONE_PRESETS[spec.preset],
        navigation: spec.navigation,
        banners: [],
        modules: [
          ...(spec.announcement
            ? [
                {
                  id: 'attribution',
                  type: 'announcement',
                  title: spec.announcement,
                  source: { kind: 'query-block', block: 'new-adoptions' },
                },
              ]
            : []),
          ...mounts.map((mount) => ({
            id: mount.id,
            type: 'shelf',
            title: mount.name,
            source: { kind: 'collection', collection: collections[mount.id] },
            options: { limit: 12 },
          })),
        ],
      },
    };
    const actual = {
      name: configuration.name,
      language: configuration.language,
      defaultRealm: configuration.configuration.defaultRealm,
      official: configuration.configuration.official,
      presentation: configuration.configuration.presentation,
    };
    if (unfinished(`configuration:${spec.id}`) || !isDeepStrictEqual(actual, desired)) {
      await command(
        'PUT',
        `/v1/zones/${short(zone)}/configuration`,
        {
          expectedHead: configuration.revision,
          actingSubject: actor,
          ...desired,
        },
        `configuration:${spec.id}`,
        desired,
      );
    }
    result.zones.push({ id: spec.id, zone, realm: realm.realm, collections });
  }
  result.definitions = await seedRelationLexicon(
    {
      post: (path, body, label) =>
        journal.command(
          api,
          label,
          'POST',
          path,
          path === '/v1/lexicon/presentations'
            ? { ...body, state: { ...(body as { state: object }).state, reviewStatus: 'reviewed' } }
            : body,
        ),
      // Access recognizes the platform administrator and live Agent control.
      // Reviewed launch labels are public; every write admits that authority.
      authorizeDefinition: async (receipt) => {
        await api.read(
          `/v1/semantic/resources/${short(receipt.component)}?actingSubject=${encodeURIComponent(actor)}`,
        );
      },
    },
    actor,
    plan.namespace,
    relationLexiconSeed,
    inside(root, `.temp/bootstrap/${plan.namespace}/lexicon.v3.json`),
  );
  const vocabularyClient = {
    post: <T>(path: string, body: object, label: string) => journal.command<T>(api, label, 'POST', path, body),
    authorizeDefinition: async (receipt: { component: string }) => {
      await api.read(`/v1/semantic/resources/${short(receipt.component)}?actingSubject=${encodeURIComponent(actor)}`);
    },
  };
  result.vocabulary = { variantKinds: await seedVariantKindConcepts(vocabularyClient, actor, plan.namespace),
    canonicity: await seedCanonicity(vocabularyClient, actor, plan.namespace) };
  const effects: { target: string; receipt: string }[] = [];
  for (const source of plan.sources.filter((source) => source.enabled)) {
    const imported: BootstrapResult['sources'][number] = {
      id: source.id,
      version: source.version,
      dumpSha256: source.dumpSha256,
      sliceSha256: source.sliceSha256,
      rightsEvidenceDate: source.rightsEvidenceDate,
      steward: source.steward,
      backup: source.backup,
      attribution: source.attribution,
      works: [],
    };
    for (const record of source.records) {
      const observed = await command<{ observation: { observation: string } }>(
        'POST',
        '/v1/sources/intakes',
        {
          profile: 'source-manual-intake-v1',
          provider: source.id,
          namespace: 'launch-catalogue',
          externalId: record.id,
          sourceRevision: source.version,
          mediaType: 'application/json',
          retention: 'retained',
          rawBytesBase64: Buffer.from(
            JSON.stringify(evidence.get(`${source.id}:${record.id}`)),
          ).toString('base64'),
          coverage: {
            scope: 'launch-title-slice',
            complete: false,
            omittedFields: ['descriptions', 'images', 'ratings', 'releases'],
          },
          rightsEvidence: {
            basis: 'license',
            note: `${source.licence}; ${source.rightsEvidence} (${source.rightsEvidenceDate}); ${source.attribution}`,
          },
        },
        `intake:${source.id}:${record.id}`,
      );
      const label = `work:${source.id}:${record.id}`;
      const saved = journal.state.entries[key(label)];
      let candidates: { candidateReceipt: string; candidates: unknown[] } | undefined;
      if (!saved) {
        const found = await api.write<{ candidateReceipt: string; candidates: unknown[] }>(
          'POST',
          '/v1/catalogue/candidates',
          {
            profile: 'catalogue-candidates-v1',
            originalTitle: record.title,
            aliases: record.aliases,
            romanizations: record.romanizations,
            creators: record.creators,
            dates: record.dates,
            identifiers: record.identifiers,
          },
          key(`search:${source.id}:${record.id}`),
        );
        candidates = found;
        if (found.candidates.length)
          throw new Error(`Source ${source.id}/${record.id} requires candidate adjudication`);
      }
      const body = saved?.body ?? {
        profile: 'metadata-only-v1',
        authoring: 'catalogue',
        grain: record.grain,
        candidateReceipt: candidates!.candidateReceipt,
        title: record.title.value,
        language: record.title.language,
        semanticTypes: record.semanticTypes,
        aliases: record.aliases,
        romanizations: record.romanizations,
        description: {
          value: `${source.attribution} Source: ${source.dumpUrl} (${source.version}); record ${record.id}; observation ${observed.observation.observation}.`,
          language: 'en',
        },
        actingSubject: actor,
      };
      const work = await command<WorkReceipt>('POST', '/v1/works', body, label, {
        source: source.id,
        record,
      });
      if (!work.work || !work.workRevision)
        throw new Error('Catalogue intake did not confirm a Work revision');
      // The public Work header reads descriptive metadata separately from the
      // creation manifest. Publish the retained attribution through its API.
      await command(
        'PUT',
        `/v1/works/${short(work.work)}/metadata`,
        {
          profile: 'work-metadata-details-v1',
          expectedHead: null,
          actingSubject: actor,
          state: {
            kind: 'header',
            originalTitle: record.title,
            localized: [
              {
                language: 'en',
                title: null,
                tagline: null,
                mainVersionLabel: null,
                description: `${source.attribution} Source: ${source.dumpUrl} (${source.version}); record ${record.id}; observation ${observed.observation.observation}.`,
              },
            ],
          },
        },
        `metadata:${source.id}:${record.id}`,
        { source: source.id, record },
      );
      const verified = await command<{ receipt: string }>(
        'POST',
        `/v1/works/${short(work.work)}/catalogue-verifications`,
        {
          expectedHead: work.workRevision,
          evidence: `${source.rightsEvidence}; dump ${source.dumpUrl}; sha256 ${source.dumpSha256}; record ${record.id}`,
          actingSubject: actor,
        },
        `verify:${source.id}:${record.id}`,
      );
      imported.works.push({ id: record.id, work: work.work, revision: work.workRevision });
      if (!verified.receipt) throw new Error('Catalogue verification did not confirm its receipt');
      effects.push({ target: work.work, receipt: verified.receipt });
      for (const type of record.semanticTypes) result.counts[type] = (result.counts[type] ?? 0) + 1;
      for (const zoneId of source.zones) {
        const zone = result.zones.find((zone) => zone.id === zoneId)!;
        const collection = Object.values(zone.collections)[0]!;
        const page = await api.read<{
          structure: string;
          revision: string;
          next: string | null;
          occurrences: { target?: string; state?: string }[];
        }>(
          `/v1/collections/${short(collection)}?actingSubject=${encodeURIComponent(actor)}&limit=100`,
        );
        if (page.next) throw new Error('Launch collection exceeds the bootstrap read bound');
        if (
          unfinished(`member:${zoneId}:${source.id}:${record.id}`) ||
          !page.occurrences.some((item) => item.target === work.work && item.state !== 'removed')
        ) {
          await command(
            'POST',
            `/v1/collections/${short(collection)}/changes`,
            {
              expectedHead: page.revision,
              actingSubject: actor,
              operations: [
                {
                  op: 'insert',
                  role: 'member',
                  parent: page.structure,
                  position: 'last',
                  target: work.work,
                  selection: { mode: 'follow-context' },
                },
              ],
            },
            `member:${zoneId}:${source.id}:${record.id}`,
            { collection, work: work.work },
          );
        }
      }
    }
    result.sources.push(imported);
  }
  result.outcome = operationOutcome(
    plan.namespace,
    effects.map((effect, index) => ({
      ordinal: index + 1,
      ...effect,
      state: 'confirmed',
      continuation: null,
      error: null,
    })),
  );
  return result;
}

/** Public reads prove the launch-facing result; local checkpoints are not read evidence. */
export async function verifyBootstrap(
  api: BootstrapApi,
  result: BootstrapResult,
  zones: ZoneManifest[],
): Promise<void> {
  if (!result.questions) throw new Error('Bootstrap result has no Global questions; rerun bootstrap before verification');
  for (const spec of scopedSubjectQuestions) {
    const question = result.questions[spec.key];
    for (const language of scopedSubjectLocales) {
      const read = await api.read<{ context: string; question: string; displayThreshold: number;
        owner: { kind: string }; displayQuestion: { value: string; language: string; reviewStatus: string } }>(
        `/v1/rating-contexts/${short(question.context)}?languages=${language}`, true);
      if (read.context !== question.context || read.question !== spec.labels.en || read.owner.kind !== 'global'
        || read.displayThreshold !== (spec.targetGrain === 'projection' ? 10 : 5)
        || read.displayQuestion.value !== spec.labels[language] || read.displayQuestion.language !== language
        || read.displayQuestion.reviewStatus !== (language === 'en' ? 'authored' : 'reviewed')) {
        throw new Error(`Global question ${spec.key}/${language} differs`);
      }
    }
  }
  if (result.vocabulary) {
    for (const concept of [...Object.values(result.vocabulary.variantKinds), ...Object.values(result.vocabulary.canonicity.concepts)]) {
      await api.read(`/v1/resources/${short(concept)}`, true);
    }
  }
  for (const zone of result.zones) {
    const spec = zones.find((spec) => spec.id === zone.id)!;
    const lookup = await api.read<{ capabilities: { zone?: string } }>(
      `/v1/addresses/resolve?${new URLSearchParams({ scope:'space',key:spec.routeSegment })}`,
      true,
    );
    if (lookup.capabilities.zone !== zone.zone) throw new Error(`Official Zone ${zone.id} does not resolve`);
    await api.read(`/v1/zones/${short(zone.zone)}/presentation`, true);
  }
  for (const definition of result.definitions) {
    const saved = await api.read<{ definition: string }>(
      `/v1/lexicon/definitions/${definition.key}`,
      true,
    );
    if (saved.definition !== definition.component)
      throw new Error(`Vocabulary ${definition.key} differs`);
  }
  for (const source of result.sources)
    for (const work of source.works) {
      const current = await api.read<{
        id: string;
        verification?: string;
        description: { value: string } | null;
      }>(`/v1/works/${short(work.work)}?language=en`, true);
      if (
        current.id !== work.work ||
        current.verification !== 'verified' ||
        !current.description?.value.includes(source.attribution)
      ) {
        throw new Error(
          `Catalogue ${source.id}/${work.id} lacks public verification or attribution`,
        );
      }
    }
}
