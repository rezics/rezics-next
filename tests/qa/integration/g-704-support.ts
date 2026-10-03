import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { discoverEditorialAdapters } from '../../../services/main/src/modules/editorial-review/adapters.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import {
  NotificationStore,
  type StreamPage,
} from '../../../services/main/src/modules/notification/store.ts';
import { editorialNotificationSubjectReader } from '../../../services/main/src/modules/notification-producers/editorial.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import type { WikiHistory } from '../../../services/main/src/modules/wiki/history.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import {
  checkedMetadataState,
  metadataComponent,
} from '../../../services/main/src/modules/work/metadata-schema.ts';
import { startMediaStack } from './media-support.ts';

export const id = () => `https://rezics.com/id/${randomUUID()}`;
export const short = (iri: string) => iri.slice('https://rezics.com/id/'.length);
export type Command = {
  proposal: string;
  revision: number;
  outcome: string;
  replayed?: boolean;
  receipt?: OwnerReceipt;
};
export type Member = Awaited<ReturnType<Awaited<ReturnType<typeof startMediaStack>>['member']>>;
export type History = WikiHistory & {
  sourcePosition: { dataEpoch: string; sequence: string };
  revisionSetDigest: string;
  resolutions: Record<string, unknown>;
  nextCursor: string | null;
};
export interface ProposalRead {
  proposal: {
    proposer: string;
    latestRevision: number;
    decision: { outcome: string; receipt?: OwnerReceipt } | null;
    reverts: string | null;
  };
  revision: {
    n: number;
    candidate: unknown;
    baseHeads: { component: string; head: string | null }[];
  };
  state: string;
  approvalIds: string[];
  staleApprovalIds: string[];
  blockers: { code: string }[];
  allowedActions: string[];
  timeline: { kind: string; actor: string }[];
}

/** The contribution loop's roles on one isolated stack: a contributor, a steward, a second reviewer
 * and an assistant whose credential is a separate bearer that Access represents. */
export interface MemberState {
  name: string;
  actor: string;
  principalId: string;
  issuer: string;
  subject: string;
}
export const memberState = (member: Member): MemberState => ({
  name: member.name,
  actor: member.actor,
  principalId: member.principalId,
  issuer: member.principal.issuer,
  subject: member.principal.subject,
});
/** The four roles a journey needs, made once or, in a later process of the same stack, reattached by their state. */
export type Roles = Record<'holder' | 'steward' | 'second' | 'assistant', MemberState>;

export async function loopStack(label: string, attach?: Roles) {
  const f = await startMediaStack(label, { profileCredits: true, rights: true });
  const reattached = (state: MemberState) =>
    ({
      name: state.name,
      actor: state.actor,
      principalId: state.principalId,
      principal: { issuer: state.issuer, subject: state.subject },
      token: randomUUID(),
    }) as unknown as Member;
  const holder = attach ? reattached(attach.holder) : await f.member('Contributor Cleo');
  const steward = attach ? reattached(attach.steward) : await f.member('Steward Sam');
  const second = attach ? reattached(attach.second) : await f.member('Second Reviewer Rae');
  const assistant = attach ? reattached(attach.assistant) : await f.member('Assistant Ada');
  const members = [holder, steward, second, assistant];
  if (!attach) {
    // Each credential's Account principal controls its own Agent; replacing a credential changes this row.
    for (const member of members)
      await f.accessPool.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
       VALUES ($1,$2,$3,'agent.control','infinity')`,
        [randomUUID(), member.principalId, member.actor],
      );
    // The contributor is the assistant's operator too: a controller of the proposer is never an independent reviewer.
    await f.accessPool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`,
      [randomUUID(), holder.principalId, assistant.actor],
    );
  }
  const tokenPrincipals = new Map<string, Member['principal']>(
    members.map((member) => [member.token, member.principal]),
  );
  const actorOf = new Map<string, string>(members.map((member) => [member.token, member.actor]));
  const objects = f.objects('semantic/structure/');
  await objects.initialize();
  // Work revisions are committed by whichever Main wrote them (the browser's, in the e2e stack): read them where they live.
  const workObjects = f.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(f.env, { workObjects });
  const notificationStore = new NotificationStore(f.accessPool);
  const diagnostics: string[] = [];
  // Faults the journeys switch on: the owner commits, then its acknowledgement or receipt read is lost.
  const faults = {
    loseHeaderResponse: false,
    hideReceipts: false,
    headerWrites: 0,
    pausePublication: null as string | null,
  };
  const evidence = new WikiEvidenceStore(f.contentPool);
  const nativePublish = evidence.publish.bind(evidence);
  evidence.publish = async (...args) => {
    if (args[1] === faults.pausePublication) {
      faults.pausePublication = null;
      throw new Error('Evidence owner interrupted before commit');
    }
    return nativePublish(...args);
  };
  const graph = new Proxy(f.env.fuseki, {
    get(target, property) {
      if (property === 'commandWithReceipt') {
        return async (envelope: CommandEnvelope) => {
          const isHeader = envelope.update.includes('WorkMetadataChangedEvent');
          if (isHeader) faults.headerWrites++;
          const result = await target.commandWithReceipt(envelope);
          if (isHeader && faults.loseHeaderResponse) {
            faults.loseHeaderResponse = false;
            faults.hideReceipts = true;
            throw new Error('lost committed owner response');
          }
          return result;
        };
      }
      if (property === 'query') {
        return (...args: Parameters<typeof target.query>) => {
          if (
            faults.hideReceipts &&
            args[0].includes('SELECT ?outcome ?digest ?authority ?scope ?epoch')
          ) {
            throw new Error('owner receipt temporarily unreachable');
          }
          return target.query(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  f.access.configureBaseline(graph);
  const deps: MainWorkDependencies = {
    environment: { ...f.env, fuseki: graph },
    access: f.access,
    account: {
      verify: async (request) => {
        const principal = tokenPrincipals.get(
          request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
        );
        if (!principal) throw new Error('QA bearer is missing');
        return principal;
      },
    },
    structureObjects: objects,
    wikiEvidence: evidence,
    wikiQuotations: new WikiQuotationStore(f.contentPool),
    exports: new ExportStore(f.contentPool),
    media: f.media,
    mediaAccess: f.mediaAccess,
    readingPositions: new ReadingPositionStore(f.contentPool),
    editorialReview: new EditorialReviewStore(f.accessPool, discoverEditorialAdapters()),
    rights: { store: new RightsStore(f.contentPool, f.accessPool) },
    notifications: { store: notificationStore },
  };
  notificationStore.registerReadSubjectReader(
    'editorial-proposal-v1',
    editorialNotificationSubjectReader(f.accessPool, f.env),
  );
  const producer = new NotificationProducer(
    f.accessPool,
    null,
    f.contentPool,
    f.env.fuseki,
    notificationStore,
    null,
  );
  const app = createMainApp(graph, deps);

  let lastRequest = '';
  const call = (
    method: string,
    path: string,
    body?: object,
    token: string | null = holder.token,
    key: string = randomUUID(),
  ) => {
    lastRequest = `${method} ${path}`;
    const separator = path.includes('?') ? '&' : '?';
    // Account-scoped routes name their principal by token alone; Work reads name the acting Agent.
    const acting =
      method === 'GET' && token && !path.startsWith('/v1/me/')
        ? `${separator}actingSubject=${encodeURIComponent(actorOf.get(token)!)}`
        : '';
    return app.handle(
      new Request(`http://main.local${path}${acting}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`${lastRequest} -> ${response.status} expected ${status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const path = (proposal: string, suffix = '') => `/v1/editorial/proposals/${proposal}${suffix}`;
  const read = async (proposal: string, who: Member | null = steward, query = '') =>
    json<ProposalRead>(await call('GET', path(proposal) + query, undefined, who?.token ?? null));
  const review = (
    proposal: string,
    revision: number,
    outcome: 'approve' | 'request_changes' | 'comment',
    who: Member,
    message = 'Reviewed',
  ) =>
    call(
      'POST',
      path(proposal, '/reviews'),
      {
        profile: 'editorial-proposal-review-v1',
        revision,
        outcome,
        message,
        actingSubject: who.actor,
      },
      who.token,
    );
  const decide = (
    proposal: string,
    revision: number,
    who: Member,
    approve = true,
    key: string = randomUUID(),
  ) =>
    call(
      'POST',
      path(proposal, '/decisions'),
      {
        profile: 'editorial-proposal-decide-v1',
        revision,
        outcome: 'applied',
        approve,
        message: 'Checked evidence',
        actingSubject: who.actor,
      },
      who.token,
      key,
    );
  /** Ordered owners finish in bounded deliveries: keep deciding with the same key until the receipt exists. */
  const apply = async (
    proposal: string,
    revision: number,
    who: Member = steward,
    key: string = randomUUID(),
  ) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await decide(proposal, revision, who, true, key);
      const result = await json<Command>(response, response.status === 202 ? 202 : 200);
      if (result.receipt) return result.receipt;
    }
    throw new Error(
      `Proposal ${proposal} did not finish its bounded deliveries: ${diagnostics.slice(-5).join('; ')}`,
    );
  };
  const revise = (
    proposal: string,
    revision: number,
    candidate: unknown,
    baseHeads: unknown,
    who: Member,
  ) =>
    call(
      'POST',
      path(proposal, '/revisions'),
      {
        profile: 'editorial-proposal-revise-v1',
        revision,
        candidate,
        baseHeads,
        evidence: [],
        actingSubject: who.actor,
      },
      who.token,
    );
  const withdraw = (proposal: string, revision: number, who: Member) =>
    call(
      'POST',
      path(proposal, '/withdrawal'),
      {
        profile: 'editorial-proposal-withdraw-v1',
        revision,
        actingSubject: who.actor,
      },
      who.token,
    );
  const revert = async (proposal: string, who: Member = holder) =>
    json<Command>(
      await call(
        'POST',
        path(proposal, '/reversal'),
        {
          profile: 'editorial-proposal-revert-v1',
          evidence: [],
          actingSubject: who.actor,
        },
        who.token,
      ),
      201,
    );
  const inbox = async (who: Member, query = '') => {
    // A shard retains earlier journeys' events. One production tick is a
    // bounded page, so deliver through the writes captured before this read.
    const through = (await f.accessPool.query<{ position: string }>(
      'SELECT coalesce(max(sequence),0)::text AS position FROM access.editorial_event',
    )).rows[0]!.position;
    for (;;) {
      const cursor = (await f.accessPool.query<{ position: string }>(
        "SELECT position::text FROM access.notification_producer_cursor WHERE consumer = 'editorial-notification-v1'",
      )).rows[0];
      if (cursor && BigInt(cursor.position) >= BigInt(through)) break;
      if (!await producer.runEditorialOnce()) throw new Error('Editorial notification delivery did not advance');
    }
    return json<StreamPage>(
      await call('GET', `/v1/me/notifications${query}`, undefined, who.token),
    );
  };
  const blocker = async (response: Response, status: number) =>
    (await json<{ blocker: { code: string } }>(response, status)).blocker.code;
  const head = async (iri: string) => {
    const rows =
      (
        await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
      <${iri}> rv:head ?head } }`)
      ).results?.bindings ?? [];
    return rows[0]!.head!.value;
  };

  /** A catalogue Work the contributor created through the API, with the authority each role needs on it. */
  const catalogueWork = async (title: string, language: string) => {
    await holder.grant('work:create:root', 'work.create');
    const created = await json<{ work: string; mainVersion: string; workRevision: string }>(
      await call('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        authoring: 'own-work',
        title,
        language,
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: holder.actor,
      }),
      201,
    );
    for (const member of members) await member.grant(`work:read:${created.work}`, 'work.read');
    for (const reviewer of [steward, second]) {
      await reviewer.grant(`work:review:${created.work}`, 'work.review');
      await reviewer.grant(`work:edit:${created.work}`, 'work.edit');
    }
    await holder.grant(`work:edit:${created.work}`, 'work.edit');
    // The steward is the Work's maintainer: review requests reach them as the Work's steward.
    await f.accessPool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [
      created.work,
      steward.actor,
    ]);
    return created;
  };
  /** A new bearer for the assistant's Agent: Access moves every active representation to it and ends the old one. */
  const replaceCredential = async (member: Member) => {
    const token = randomUUID(),
      principalId = randomUUID();
    const principal = {
      issuer: member.principal.issuer,
      subject: `${member.name}-replacement-${randomUUID()}`,
    };
    await f.accessPool.query(
      'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject],
    );
    await f.accessPool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),$1,subject_id,action,valid_until FROM access.representation
      WHERE principal_id = $2 AND subject_id = $3 AND active`,
      [principalId, member.principalId, member.actor],
    );
    await revokeCredential(member);
    tokenPrincipals.set(token, principal);
    actorOf.set(token, member.actor);
    return { ...member, token, principal, principalId };
  };
  /** The credential stops working and no longer represents its Agent; what the Agent made stays. */
  const revokeCredential = async (member: Member) => {
    tokenPrincipals.delete(member.token);
    await f.accessPool.query(
      `UPDATE access.representation SET active = false
      WHERE principal_id = $1 AND subject_id = $2`,
      [member.principalId, member.actor],
    );
  };
  const header = (title: string, language: string, description: string) =>
    checkedMetadataState({
      kind: 'header',
      originalTitle: { value: title, language },
      localized: [{ language, title: null, description, mainVersionLabel: null }],
    });
  /** A header correction against the Work's current header head (`null` until it has one). */
  const correction = async (
    work: { work: string },
    who: Member,
    state: ReturnType<typeof header>,
    baseHead: string | null = null,
  ) =>
    json<Command>(
      await call(
        'POST',
        '/v1/editorial/proposals',
        {
          profile: 'editorial-proposal-create-v1',
          kind: 'component-correction',
          target: {
            resource: work.work,
            revision: await head(work.work),
            context: 'urn:rezics:context:global',
          },
          candidate: { command: 'work-metadata', state },
          baseHeads: [{ component: metadataComponent(work.work, state), head: baseHead }],
          evidence: [],
          actingSubject: who.actor,
        },
        who.token,
      ),
      201,
    );

  return {
    f,
    holder,
    steward,
    second,
    assistant,
    members,
    deps,
    app,
    graph,
    faults,
    call,
    json,
    path,
    read,
    review,
    decide,
    apply,
    revise,
    withdraw,
    revert,
    inbox,
    blocker,
    head,
    catalogueWork,
    header,
    correction,
    producer,
    notificationStore,
    diagnostics,
    replaceCredential,
    revokeCredential,
    close: () => f.stop(),
  };
}
export type Loop = Awaited<ReturnType<typeof loopStack>>;

/** A public Pride and Prejudice Work with four chapters, a franchise wiki Zone and the reviewed-bundle candidate
 * for its first three chapters, built through Main's routes as the contributor. */
export async function wikiWorld(L: Loop, title = 'Pride and Prejudice') {
  const { f, holder, steward, second, assistant, call, json } = L;
  await holder.grant('work:create:root', 'work.create');
  const work = await json<{ work: string; mainVersion: string; workRevision: string }>(
    await call('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title,
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      actingSubject: holder.actor,
    }),
    201,
  );
  // Publish a synopsis and select it as the Main Version default, so the Work and its wiki are public.
  await holder.grant(`contribution:create:${work.work}`, 'contribution.create');
  const draft = await json<{ contribution: string; draftRevision: string }>(
    await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: work.work,
      language: 'en',
      body: `${title}, chapters 1–3`,
      actingSubject: holder.actor,
    }),
    201,
  );
  await holder.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  await holder.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
  const publication = await json<{ publicationDecision: string }>(
    await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: holder.actor,
    }),
    201,
  );
  await holder.grant(`publication:select:${work.mainVersion}`, 'publication.select');
  await json(
    await call('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work,
      contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: holder.actor,
    }),
    201,
  );
  await f.accessPool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [
    work.work,
    steward.actor,
  ]);
  await holder.grant(`work:read:${work.work}`, 'work.read');
  await holder.grant(`work:edit:${work.work}`, 'work.edit');
  await assistant.grant(`work:read:${work.work}`, 'work.read');
  for (const reviewer of [steward, second]) {
    await reviewer.grant(`work:read:${work.work}`, 'work.read');
    await reviewer.grant(`work:review:${work.work}`, 'work.review');
    await reviewer.grant(`work:edit:${work.work}`, 'work.edit');
  }
  const structure = await json<{ structure: string; revision: string }>(
    await call('POST', '/v1/compositions', {
      profile: 'book-composition',
      work: work.work,
      mainVersion: work.mainVersion,
      actingSubject: holder.actor,
    }),
    201,
  );
  const chapters = await json<{ occurrences: string[] }>(
    await call('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
      profile: 'book-composition',
      expectedHead: structure.revision,
      actingSubject: holder.actor,
      operations: [1, 2, 3, 4].map((n) => ({
        op: 'insert',
        parent: structure.structure,
        role: 'chapter',
        position: 'last',
        target: 'https://schema.org/DigitalDocument',
        label: { value: `Chapter ${n}`, language: 'en' },
      })),
    }),
  );
  const collections: Record<string, string> = {};
  for (const segment of ['franchise', 'characters', 'places', 'events', 'chapters']) {
    const collection = id();
    for (const member of [holder, steward])
      await member.grant(`collection:edit:${collection}`, 'collection.edit');
    for (const reader of [holder, assistant])
      await reader.grant(`semantic:read:${collection}`, 'semantic.read');
    const created = await json<{ structure: string; revision: string }>(
      await call('POST', '/v1/collections', {
        collection,
        name: segment,
        language: 'en',
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
      201,
    );
    if (segment === 'franchise') {
      await json(
        await call('POST', `/v1/collections/${short(collection)}/changes`, {
          expectedHead: created.revision,
          actingSubject: holder.actor,
          operations: [
            {
              op: 'insert',
              parent: created.structure,
              role: 'member',
              position: 'last',
              target: work.work,
            },
          ],
        }),
      );
    }
    collections[segment] = collection;
  }
  await holder.grant('space:create:root', 'space.create');
  const space = await json<{ space: string }>(
    await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1',
      name: `${title} wiki`,
      capabilities: ['realm'],
      actingSubject: holder.actor,
    }),
    201,
  );
  const zone = id();
  await holder.grant(`zone:edit:${zone}`, 'zone.edit');
  for (const reader of [holder, assistant])
    await reader.grant(`semantic:read:${zone}`, 'semantic.read');
  let navigation = await json<{ revision: string }>(
    await call('POST', '/v1/zones', {
      zone,
      space: space.space,
      disclosure: 'public',
      actingSubject: holder.actor,
    }),
    201,
  );
  for (const [routeSegment, target] of Object.entries(collections)) {
    navigation = await json(
      await call('POST', `/v1/zones/${short(zone)}/mounts`, {
        expectedHead: navigation.revision,
        target,
        routeSegment,
        position: 'last',
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
    );
  }
  await holder.grant('semantic:create:root', 'semantic.change');
  await steward.grant('semantic:create:root', 'semantic.change');
  await steward.grant('relation:create:root', 'relation.change');
  await steward.grant('rights:assess', 'rights.assess');
  await steward.grant(`statement:speak:${steward.actor}`, 'statement.record');
  await steward.grant(`statement:speak:${steward.actor}`, 'statement.withdraw');
  // The second reviewer decides what the steward cannot (their own reversal), so holds the same owner authority.
  await second.grant('semantic:create:root', 'semantic.change');
  await second.grant('relation:create:root', 'relation.change');
  await second.grant(`statement:speak:${second.actor}`, 'statement.record');
  await second.grant(`statement:speak:${second.actor}`, 'statement.withdraw');
  const definition = async (state: object) => {
    const created = await json<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: holder.actor,
        state,
      }),
      201,
    );
    for (const reader of [holder, assistant])
      await reader.grant(`semantic:read:${created.component}`, 'semantic.read');
    return created.component;
  };
  const property = await definition({ component: 'definition', kind: 'property' });
  const relation = await definition({
    component: 'definition',
    kind: 'relation',
    roles: [
      { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
      { key: 'object', minParticipants: 1, maxParticipants: 1, ordered: false },
    ],
  });
  const source = {
    representationSha256: 'a'.repeat(64),
    mediaType: 'text/plain',
    language: 'en',
    rightsBasis: 'public_domain' as const,
    method: { agent: 'Assistant extraction agent', model: 'local', inference: 'local' as const },
  };
  const evidenceFor = (quote: string) => ({
    quote,
    locator: {
      version: 'rezics-locator-v1' as const,
      source: {
        type: 'external' as const,
        representationSha256: source.representationSha256,
        mediaType: source.mediaType,
      },
      selector: { type: 'TextQuoteSelector' as const, exact: quote },
    },
  });
  const bundle: WikiExtraction = {
    profile: 'wiki-extraction-v1',
    target: work.work,
    continuity: work.work,
    zone,
    source,
    units: chapters.occurrences.slice(0, 3).map((occurrence, index) => ({
      id: `ch${index + 1}`,
      ordinal: index,
      label: `Chapter ${index + 1}`,
      occurrence,
    })),
    entities: [
      {
        id: 'elizabeth',
        type: `${RV}Character`,
        names: [
          { value: 'Elizabeth Bennet', language: 'en', kind: 'primary', revealedAt: 'ch1' },
          { value: 'Lizzy', language: 'en', kind: 'alias', revealedAt: 'ch2' },
        ],
      },
      {
        id: 'jane',
        type: `${RV}Character`,
        names: [{ value: 'Jane Bennet', language: 'en', kind: 'primary', revealedAt: 'ch1' }],
      },
    ],
    claims: [
      {
        subject: 'elizabeth',
        predicate: property,
        object: { kind: 'literal', value: 'Bennet family' },
        modality: 'narrated',
        continuity: work.work,
        revealedAt: 'ch1',
        evidence: [evidenceFor('The Bennet family')],
      },
      {
        subject: 'elizabeth',
        predicate: relation,
        object: { kind: 'entity', ref: 'jane' },
        modality: 'narrated',
        continuity: work.work,
        revealedAt: 'ch3',
        evidence: [evidenceFor('Elizabeth and Jane')],
      },
    ],
  };
  return { work, bundle, chapters, zone, property, relation, evidenceFor };
}
export type WikiWorld = Awaited<ReturnType<typeof wikiWorld>>;
