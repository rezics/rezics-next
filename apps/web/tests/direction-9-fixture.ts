import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PublicResponse {
  status(): number;
  json(): Promise<unknown>;
}
export interface PublicRequest {
  get(path: string): Promise<PublicResponse>;
  fetch(
    path: string,
    options: { method: string; data: unknown; headers: Record<string, string> },
  ): Promise<PublicResponse>;
}

/** Every setup write goes through the browser's authenticated public BFF. */
export class PublicCommands {
  constructor(
    private readonly request: PublicRequest,
    private readonly delay = () => new Promise<void>((done) => setTimeout(done, 500)),
  ) {}

  async read<T>(path: string): Promise<T> {
    const response = await this.request.get(`/api/main/v1${path}`);
    if (response.status() !== 200)
      throw new Error(`Fixture GET ${path}: HTTP ${response.status()}`);
    return (await response.json()) as T;
  }

  async write<T>(
    path: string,
    data: unknown,
    method = 'POST',
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const key = randomUUID();
    // An unknown outcome is retried with exactly the same intent and key. Denied,
    // stale and validation failures are setup failures, never feature skips.
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await this.request.fetch(`/api/main/v1${path}`, {
        method,
        data,
        headers: { ...extraHeaders, 'idempotency-key': key },
      });
      const status = response.status();
      if (status === 200 || status === 201) return (await response.json()) as T;
      if ((status !== 202 && status !== 503) || attempt === 39) {
        const body = await response.json();
        const code = body && typeof body === 'object' && 'code' in body ? body.code : 'unknown';
        throw new Error(`Fixture ${method} ${path}: HTTP ${status} (${String(code)})`);
      }
      await this.delay();
    }
    throw new Error(`Fixture ${path} did not settle`);
  }
}

export interface Credentials {
  member: { email: string; password: string };
  operator: { email: string; password: string };
}
export function credentials(): Credentials {
  // Never follow a brief's absolute path back into the main checkout.
  const path =
    process.env.REZICS_WEB_AUTH_PRIVATE_PATH ??
    resolve('.temp/stack/rezics-dev/web-auth/private.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
}

export interface SpaceRecord {
  space: string;
  realm: string;
  name: string;
  handle?: string;
}
export interface WorkRecord {
  work: string;
  mainVersion: string;
  contribution: string;
  publicationDecision: string;
}
export interface DirectionFixture {
  actor: string;
  manager: string;
  namedPerson: string;
  unnamedPerson: string;
  personHandle: string;
  spaces: SpaceRecord[];
  named: SpaceRecord;
  unnamed: SpaceRecord;
  private: SpaceRecord;
  privateSpaces: SpaceRecord[];
  unlisted: SpaceRecord;
  work: WorkRecord;
  story: WorkRecord;
  zone: string;
  topic: { concept: string; name: string };
  laterChapter: { occurrence: string; name: string };
}

export const short = (iri: string) => iri.slice(-36);
export const populationCount = 32;
export const chapterCount = 80;

export async function seedDirection(
  api: PublicCommands,
  actor: string,
  managerApi: PublicCommands,
): Promise<DirectionFixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const person = async (name: string, commands = api) =>
    (
      await commands.write<{ agent: string }>('/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: name,
      })
    ).agent;
  const manager = await person(`Direction 9 manager ${suffix}`, managerApi);
  const namedPerson = await person(`Direction 9 reader ${suffix}`);
  const unnamedPerson = await person(`Direction 9 unnamed reader ${suffix}`);
  const personHandle = `d9-reader-${suffix}`;
  const claim = (scope: string, holder: string, name: string, actingSubject = manager) =>
    (actingSubject === manager ? managerApi : api).write('/addresses/claims', {
      profile: 'name-write-v1',
      scope,
      holder,
      actingSubject,
      operation: 'claim',
      name,
      expectedRevision: null,
    });
  await claim('agent', namedPerson, personHandle, namedPerson);

  const topicName = `Direction 9 主題 ${suffix}`;
  const topic = await managerApi.write<{ concept: string }>('/classification-vocabulary', {
    profile: 'classification-proposition-v2',
    scheme: null,
    labels: [
      { language: 'en', value: topicName },
      { language: 'zh-Hant', value: topicName },
    ],
    alternativeLabels: [],
    broader: [],
    narrower: [],
    actingSubject: manager,
  });
  const spaces: SpaceRecord[] = [];
  for (let index = 0; index < populationCount; index++) {
    const name = `Direction 9 ${suffix} community ${String(index + 1).padStart(2, '0')}`;
    const handle = index === 1 ? undefined : `d9-${suffix}-${index + 1}`;
    const record = await managerApi.write<{ space: string; realm: string }>('/spaces', {
      profile: 'space-realm-v2',
      name,
      language: 'en',
      capabilities: ['realm'],
      ...(handle ? { handle } : {}),
      topics: [topic.concept],
      actingSubject: manager,
    });
    spaces.push({ ...record, name, ...(handle ? { handle } : {}) });
  }
  const named = spaces[0]!,
    unnamed = spaces[1]!,
    unlisted = spaces[6]!;
  const privateSpaces = spaces.slice(2, 6);
  for (const space of [...privateSpaces, unlisted]) {
    const isUnlisted = space === unlisted;
    const current = await managerApi.read<{ generation: string }>(
      `/spaces/${short(space.space)}/settings?actingSubject=${encodeURIComponent(manager)}`,
    );
    await managerApi.write(
      `/spaces/${short(space.space)}/settings`,
      {
        actingSubject: manager,
        expectedGeneration: current.generation,
        reason: 'Direction 9 acceptance fixture',
        settings: {
          visibility: isUnlisted ? 'public' : 'private',
          listing: isUnlisted ? 'unlisted' : 'listed',
          admission: isUnlisted ? 'open' : 'request',
          history: 'everything',
        },
      },
      'PUT',
    );
  }
  const createWork = async (title: string, type: string): Promise<WorkRecord> => {
    const work = await api.write<{ work: string; mainVersion: string }>('/works', {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title,
      language: 'en',
      semanticTypes: [type],
      actingSubject: actor,
    });
    const contribution = await api.write<{ contribution: string; draftRevision: string }>(
      '/contributions',
      {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `Synthetic public acceptance text for ${title}.`,
        actingSubject: actor,
      },
    );
    const published = await api.write<{ publicationDecision: string }>(
      '/contribution-publications',
      {
        profile: 'text-publication-v1',
        contribution: contribution.contribution,
        expectedDraftHead: contribution.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: actor,
      },
    );
    await api.write('/publication-selections', {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work,
      contribution: contribution.contribution,
      publicationDecision: published.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: actor,
    });
    return {
      ...work,
      contribution: contribution.contribution,
      publicationDecision: published.publicationDecision,
    };
  };
  const work = await createWork(`Direction 9 Work ${suffix}`, 'https://schema.org/CreativeWork');
  const story = await createWork(`Direction 9 story ${suffix}`, 'https://schema.org/Book');
  await claim('work', work.work, `d9-work-${suffix}`, actor);
  await claim('concept', topic.concept, `d9-topic-${suffix}`);

  for (const space of spaces) {
    const context = await managerApi.write<{ context: string }>('/rating-contexts', {
      profile: 'realm-standing-rating-context-v1',
      realm: space.realm,
      question: 'How much did you enjoy this Work?',
      actingSubject: manager,
    });
    await managerApi.write('/rating-observations', {
      profile: 'realm-standing-rating-observation-v1',
      context: context.context,
      work: work.work,
      mainVersion: work.mainVersion,
      expectedRevisionHead: null,
      value: 8,
      actingSubject: manager,
    });
  }
  const composition = await api.write<{ structure: string; revision: string }>('/compositions', {
    profile: 'book-composition',
    work: story.work,
    mainVersion: story.mainVersion,
    actingSubject: actor,
  });
  let head = composition.revision;
  let laterChapter!: DirectionFixture['laterChapter'];
  for (let offset = 0; offset < chapterCount; offset += 16) {
    const name = `Direction 9 遠方 chapter ${chapterCount} ${suffix}`;
    const changed = await api.write<{ revision: string; occurrences: string[] }>(
      `/compositions/${short(composition.structure)}/changes`,
      {
        profile: 'book-composition',
        expectedHead: head,
        actingSubject: actor,
        operations: Array.from({ length: 16 }, (_, index) => ({
          op: 'insert',
          parent: composition.structure,
          role: 'chapter',
          position: 'last',
          target: 'https://schema.org/DigitalDocument',
          label: {
            value: offset + index + 1 === chapterCount ? name : `Chapter ${offset + index + 1}`,
            language: 'en',
          },
        })),
      },
    );
    head = changed.revision;
    if (offset + 16 === chapterCount)
      laterChapter = { occurrence: changed.occurrences.at(-1)!, name };
  }
  const zone = `https://rezics.com/id/${randomUUID()}`;
  const site = await managerApi.write<{ revision: string }>('/zones', {
    zone,
    space: named.space,
    name: named.name,
    language: 'en',
    disclosure: 'public',
    actingSubject: manager,
  });
  await managerApi.write(`/zones/${short(zone)}/mounts`, {
    expectedHead: site.revision,
    target: story.work,
    routeSegment: 'story',
    disclosure: 'public',
    actingSubject: manager,
  });
  return {
    actor,
    manager,
    namedPerson,
    unnamedPerson,
    personHandle,
    spaces,
    named,
    unnamed,
    private: privateSpaces[0]!,
    privateSpaces,
    unlisted,
    work,
    story,
    zone,
    topic: { concept: topic.concept, name: topicName },
    laterChapter,
  };
}
