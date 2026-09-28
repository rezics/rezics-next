import { createHash } from 'node:crypto';
import { CONTINUITY, ID } from '../../services/main/src/modules/work/activate.ts';

/** Changing what any owner stores for the same entity requires a new fixture format. */
export const FIXTURE_FORMAT = 'rezics-fixture-v2';
export const DEFAULT_SEED = 'rezics-background-v1';
/** Imported background precedes every command, like the bootstrap: graph position 0. */
export const IMPORT_SEQUENCE = '0';
/** Fixed timestamps keep physical rows identical for the same seed and profile. */
export const IMPORTED_AT = '2026-01-01T00:00:00.000Z';
export const BACKGROUND_GRANTS_UNTIL = '2100-01-01T00:00:00.000Z';
// A live catalogue expansion must not change the bytes of an existing fixture format.
const FIXTURE_SEMANTIC_TYPES = [
  'https://schema.org/Book', 'https://schema.org/DigitalDocument', 'https://schema.org/Recipe',
] as const;

/** Sized by entities; each owner derives its rows, triples and objects from these. */
export const PROFILES = {
  small: { works: 1_000, worksPerAgent: 100, publicUnits: 100 },
  medium: { works: 100_000, worksPerAgent: 100, publicUnits: 10_000 },
} as const;
export type FixtureProfile = keyof typeof PROFILES;

export interface Corpus {
  profile: FixtureProfile;
  seed: string;
  works: number;
  agents: number;
  publicUnits: number;
  lineage: { dataEpoch: string; routingEpoch: string };
  /** One bulk import operation; imported revisions have no interactive receipts. */
  importOperation: string;
}

export interface FixtureWork {
  index: number;
  work: string;
  mainVersion: string;
  workRevision: string;
  mainRevision: string;
  title: string;
  token: string;
  semanticTypes: string[];
  agent: string;
  variant: string;
  contentRevision: string;
  language: 'en' | 'zh' | 'ja';
  contentBody: string;
}

export interface FixturePublicUnit {
  work: FixtureWork;
  contribution: string;
  decision: string;
  selection: string;
  draft: string;
  unit: string;
  body: string;
}

const WORDS = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor',
  'indigo', 'juniper', 'kestrel', 'lantern', 'meadow', 'nimbus', 'orchard', 'pebble',
  'quartz', 'raven', 'saffron', 'tundra', 'umber', 'violet', 'willow', 'yarrow'];
const BODIES = {
  en: (token: string) => `${token} background English Content revision`,
  zh: (token: string) => `${token} 背景中文内容修订`,
  ja: (token: string) => `${token} 背景の日本語コンテンツ改訂`,
} as const;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 9562 version-8 UUID: deterministic, collision-resistant within one seed. */
export function fixtureUuid(seed: string, label: string): string {
  const bytes = createHash('sha256').update(`${FIXTURE_FORMAT}\0${seed}\0${label}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function checkedSeed(seed: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(seed)) throw new Error('fixture seed must match [a-z0-9][a-z0-9-]{0,39}');
  return seed;
}

/** `works` overrides the profile size only for unit tests of determinism. */
export function fixtureCorpus(profile: FixtureProfile, seed = DEFAULT_SEED,
  works: number = PROFILES[profile]?.works): Corpus {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`Unknown fixture profile: ${profile}`);
  if (!Number.isSafeInteger(works) || works < 3 || works > 1_000_000) {
    throw new Error('fixture Work count must be 3–1,000,000');
  }
  checkedSeed(seed);
  const agents = Math.ceil(works / PROFILES[profile].worksPerAgent);
  const publicUnits = Math.min(PROFILES[profile].publicUnits, works - 1);
  return { profile, seed, works, agents, publicUnits,
    lineage: { dataEpoch: fixtureUuid(seed, 'lineage:data'),
      routingEpoch: fixtureUuid(seed, 'lineage:routing') },
    importOperation: `urn:rezics:operation:fixture-${sha256(
      `${FIXTURE_FORMAT}\0${profile}\0${seed}\0${works}`).slice(0, 32)}` };
}

export function agentAt(corpus: Corpus, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= corpus.agents) throw new Error('agent outside corpus');
  return ID + fixtureUuid(corpus.seed, `agent:${index}`);
}

export function workToken(index: number): string {
  return `fxw${index.toString(36).padStart(6, '0')}`;
}

export function workAt(corpus: Corpus, index: number): FixtureWork {
  if (!Number.isSafeInteger(index) || index < 0 || index >= corpus.works) throw new Error('Work outside corpus');
  const id = (kind: string) => fixtureUuid(corpus.seed, `${kind}:${index}`);
  const pick = sha256(`${corpus.seed}\0words\0${index}`);
  const token = workToken(index);
  const types = FIXTURE_SEMANTIC_TYPES.filter((_, type) => (index + type) % (type + 3) === 0);
  const language = index % 7 === 3 ? 'zh' : index % 11 === 5 ? 'ja' : 'en';
  return { index, work: ID + id('work'), mainVersion: ID + id('main'),
    workRevision: ID + id('work-revision'), mainRevision: ID + id('main-revision'),
    title: `Fixture ${token} ${WORDS[parseInt(pick.slice(0, 4), 16) % WORDS.length]} ${
      WORDS[parseInt(pick.slice(4, 8), 16) % WORDS.length]}`,
    token, semanticTypes: [...types].sort(),
    agent: agentAt(corpus, Math.floor(index / PROFILES[corpus.profile].worksPerAgent)),
    variant: `urn:rezics:variant:${id('variant')}`, contentRevision: id('content-revision'),
    language, contentBody: BODIES[language](token) };
}

export function* corpusWorks(corpus: Corpus): Generator<FixtureWork> {
  for (let index = 0; index < corpus.works; index++) yield workAt(corpus, index);
}

/** Search materialization on imported Works; index zero stays metadata-only for smoke. */
export function publicUnitAt(corpus: Corpus, ordinal: number): FixturePublicUnit {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= corpus.publicUnits) {
    throw new Error('public unit outside corpus');
  }
  const work = workAt(corpus, ordinal + 1);
  const id = (kind: string) => ID + fixtureUuid(corpus.seed, `${kind}:${work.index}`);
  const common = ordinal < 64 ? 'public load ' : '';
  const degree = ordinal < 512 ? 'candidate degree ' : '';
  const overflow = ordinal >= 512 && ordinal < 1_025 ? 'overflow degree ' : '';
  const rejected = ordinal === 129 ? 'rejected sapphire harbor ' : '';
  const language = ordinal === 2 ? 'loadtokenaaah ' : ordinal === 4 ? 'loadtokenaaaj ' : '';
  const payload = ordinal === 128 ? 'largepayload '.repeat(320) : '';
  return { work, contribution: id('public-contribution'), decision: id('public-decision'),
    selection: id('public-selection'), draft: id('public-draft'), unit: id('public-unit'),
    body: `${common}${degree}${overflow}${rejected}${language}${work.token} ${payload}fixture body`.trim() };
}

export function fixtureRealm(corpus: Corpus) {
  const id = (kind: string) => ID + fixtureUuid(corpus.seed, `public-${kind}`);
  return { space: id('space'), realm: id('realm'), rejectionSlot: id('rejection-slot'),
    rejectionSelection: id('rejection-selection') };
}

export function* corpusPublicUnits(corpus: Corpus): Generator<FixturePublicUnit> {
  for (let ordinal = 0; ordinal < corpus.publicUnits; ordinal++) yield publicUnitAt(corpus, ordinal);
}

/** Exactly the state activateMetadataWork stores for a metadata-only Work. */
export function workComponentState(work: FixtureWork): Record<string, unknown> {
  return { mainVersion: work.mainVersion, continuityProfile: CONTINUITY, title: work.title,
    language: 'en', ...(work.semanticTypes.length ? { semanticTypes: work.semanticTypes } : {}) };
}

export function mainComponentState(work: FixtureWork): Record<string, unknown> {
  return { work: work.work, hostingPolicy: 'metadata-only' };
}

/** First, middle and last Works: bounded restore smoke and test targets. */
export function sampleIndices(corpus: Corpus): number[] {
  return [...new Set([0, Math.floor(corpus.works / 2), corpus.works - 1])];
}

/** Canonical JSON with sorted keys, for digests independent of insertion order. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Streaming owner summary: record count per kind plus one ordered digest. */
export class RecordDigest {
  private readonly hash = createHash('sha256');
  readonly counts: Record<string, number> = {};

  add(kind: string, canonical: string | Uint8Array): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.hash.update(kind).update('\0').update(canonical).update('\n');
  }

  finish(): { digest: string; counts: Record<string, number> } {
    return { digest: this.hash.digest('hex'),
      counts: Object.fromEntries(Object.entries(this.counts).sort(([a], [b]) => a < b ? -1 : 1)) };
  }
}
