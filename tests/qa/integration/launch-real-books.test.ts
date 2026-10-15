import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { join } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import { launchBookSources, prepareLaunchBooksCorpus, restoreLaunchBooksCorpus,
  type LaunchBooksCorpus } from '../../../scripts/load/launch-corpus.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

const short = (uri: string) => uri.slice(-36);
function apiFor(stack: MediaStack, token: string) {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: (async (input, init) => {
      // A lost command acknowledgement is still pending. Replay the exact key
      // and bytes as directed by Main; the corpus client only accepts completion.
      for (let attempt = 0; ; attempt++) {
        init?.signal?.throwIfAborted();
        const response = await stack.main.handle(new Request(input, init));
        if (response.status !== 202 || attempt === 2) return response;
        const pending = await response.json() as { retry?: { allowed?: boolean; afterMs?: number } };
        if (!pending.retry?.allowed) throw new Error('Corpus command cannot be retried');
        await Bun.sleep(Math.min(1000, Math.max(0, pending.retry.afterMs ?? 1000)));
      }
    }) as typeof fetch,
  });
}
async function openCopy(input: CorpusRestoreSmokeInput) {
  const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId, REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    return await startMediaStack('launch-books-restored', { library: true, ownerUrls: {
      access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
      relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
    } });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

interface ReleasePage {
  items: { id: string; revision: string; title: { value: string }; publisher: string | null;
    contentLanguages: string[]; editionStatement: string | null; platform: string | null;
    coverage: { realization: string | null; revision: string | null; language: string | null }[] }[];
  nextCursor: string | null;
}
interface Preference {
  work: string; language: string; version: number;
  edition: { kind: 'release'; resource: string; revision: string } | null;
}

test('books / Pinned source editions retain translation, publishers, annotation and mixed formats', () => {
  const sources = launchBookSources();
  expect(sources).toHaveLength(7);
  expect(sources[0]!.record.title).toBe('Pride and Prejudice');
  expect(sources.find(row => row.externalId === 'OL40859253M')!.record.languages).toEqual([{ key: '/languages/fre' }]);
  expect(sources.find(row => row.externalId === 'OL51673567M')!.record.publishers).toEqual(['Dell Publishing Co. Inc.']);
  expect(sources.find(row => row.externalId === 'OL51047237M')!.record.publishers).toEqual(['Cambridge University Press']);
  expect(sources.find(row => row.externalId === 'OL29868651M')!.record.title).toBe('Pride & Prejudice Annotated');
  expect(sources.map(row => row.record.physical_format).filter(Boolean).sort()).toEqual(['Audiobook', 'E-book', 'paperback']);
});

test('books / An exact pinned edition choice persists on an isolated restored corpus', async () => {
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId) throw new Error('Run through goalctl integration QA');
  const compose = readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'compose.env'));
  if (compose.REZICS_STACK_STORAGE !== 'persistent')
    throw new Error('Launch books restore needs catalogue-disk allocation (REZICS_QA_STACK_MODE=scale)');
  if (compose.REZICS_STACK_RAW_UPDATE === '1')
    throw new Error('Launch books restore needs commandOnlyIntegrationFiles registration; the raw-update fixture cannot admit the public catalogue writer');
  const source = await startMediaStack('launch-books-source', { library: true, profileCredits: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const copies = new Map<string, MediaStack>();
  let sourceClosed = false;
  let relayClosed = false;
  let corpus: LaunchBooksCorpus;
  const targets = [`launch-books-${sourceRunId}-one`, `launch-books-${sourceRunId}-two`];
  const driver = createCorpusBackupDriver({ sourceRunId,
    directory: join(root, '.temp/launch-corpus/books/backups'), resumeSource: false,
    async quiesce(signal) {
      signal.throwIfAborted();
      await relay.end();
      relayClosed = true;
      await source.stop();
      sourceClosed = true;
    },
    async smokeRead(input) {
      const stack = await openCopy(input);
      try {
        const importer = await stack.member('launch-books-importer', { stable: true, verified: true });
        const api = apiFor(stack, importer.token);
        const page = await api.read<ReleasePage>(`/v1/works/${short(corpus.work)}/releases?actingSubject=${encodeURIComponent(importer.actor)}`);
        expect(page.nextCursor).toBeNull();
        expect(new Set(page.items.map(item => item.id))).toEqual(new Set(corpus.editions.map(item => item.release)));
        // Owner startup, migrations and the actual public reads are included in restoreMs.
        for (const edition of corpus.editions) {
          const release = page.items.find(item => item.id === edition.release)!;
          expect(release.platform).toBe(edition.platform);
          expect(release.contentLanguages).toEqual(edition.contentLanguages);
          if (edition.realization) expect(release.coverage).toContainEqual(expect.objectContaining({
            realization: edition.realization, revision: edition.realizationRevision, language: edition.language,
          }));
          const observation = await api.read<{ byteDigest: string; rawBytesBase64: string }>(
            `/v1/sources/observations/${short(edition.observation)}`);
          expect(observation.byteDigest).toBe(corpus.sources.find(row => row.id === `edition-${edition.externalId}`)!.sha256);
          expect(JSON.parse(Buffer.from(observation.rawBytesBase64, 'base64').toString('utf8')).physical_format ?? null)
            .toBe(edition.sourceFormat);
        }
        copies.set(input.target, stack);
        return async () => { copies.delete(input.target); await stack.stop(); };
      } catch (error) {
        await stack.stop();
        throw error;
      }
    },
  });
  try {
    const importer = await source.member('launch-books-importer', { stable: true, verified: true });
    await grantRecordedPlatformUse(source.accessPool, importer.principalId, ['catalogue-import']);
    await importer.grant('work:create:root', 'work.create');
    await importer.grant('work:create:catalogue-import', 'work.create');
    await initializeRelayCheckpoint(relay, Bun.env.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch);
    const input = { api: apiFor(source, importer.token), actor: importer.actor, backups: driver,
      directory: join(root, '.temp/launch-corpus/books/manifests'),
      authorize: async (work: string) => { await importer.grant(`work:edit:${work}`, 'work.edit'); },
      authorizeRights: async () => { await importer.grant('rights:assess', 'rights.assess'); } };
    corpus = await prepareLaunchBooksCorpus(input);
    expect(corpus.counts).toEqual({ works: 1, realizations: 1, releases: 6, contentObservations: 7, librarySlice: 0, wikidataLabels: 0, covers: 0 });
    expect(corpus.sources.map(row => row.sha256)).toEqual(launchBookSources().map(row => row.entry.sha256));
    expect(corpus.buildMs).toBeLessThan(600_000);
    // A retained build must be reused without issuing any command or retaining another backup.
    const noBuild = async (): Promise<never> => { throw new Error('Retained corpus rebuilt'); };
    expect(await prepareLaunchBooksCorpus({ ...input,
      api: { command: noBuild, read: noBuild }, backups: { backup: noBuild, restore: noBuild }, authorize: noBuild,
    })).toEqual(corpus);
    for (const target of targets) expect(await restoreLaunchBooksCorpus(corpus, target!, driver)).toBeLessThan(600_000);
    const first = copies.get(targets[0]!)!;
    const second = copies.get(targets[1]!)!;
    const readerFor = async (stack: MediaStack) => {
      const member = await stack.member('launch-books-reader', { stable: true, verified: true });
      const api = apiFor(stack, member.token);
      const { agent } = await api.command<{ agent: string }>('launch-books-reader:person', {
        method: 'POST', path: '/v1/agents', body: {
          profile: 'agent-provision-v1', kind: 'person', displayName: 'Books reader',
        },
      });
      return { api, agent };
    };
    const reader = await readerFor(first);
    const isolatedReader = await readerFor(second);
    const page = await reader.api.read<ReleasePage>(`/v1/works/${short(corpus.work)}/releases?actingSubject=${encodeURIComponent(reader.agent)}`);
    expect(page.items).toHaveLength(6);
    expect(page.items.map(item => item.publisher)).toContain('Dell Publishing Co. Inc.');
    expect(page.items.map(item => item.publisher)).toContain('Cambridge University Press');
    expect(page.items.flatMap(item => item.contentLanguages)).toContain('fr');
    expect(page.items.map(item => item.platform).filter(Boolean).sort()).toEqual(['audiobook', 'ebook', 'paperback']);
    const chosen = corpus.editions.find(item => item.externalId === 'OL26394110M')!;
    expect(chosen.title).toBe('Pride and Prejudice');
    expect(chosen.platform).toBe('audiobook');
    expect(page.items.filter(item => item.title.value === chosen.title).length).toBeGreaterThan(1);
    const path = `/v1/me/edition-preferences/${short(corpus.work)}` as const;
    const readPath = `${path}?actingSubject=${encodeURIComponent(reader.agent)}` as const;
    expect(await reader.api.read(readPath)).toBeNull();
    const body = { actingSubject: reader.agent, expectedVersion: 0, language: 'en',
      edition: { kind: 'release', resource: chosen.release, revision: chosen.revision } };
    const { replayed, ...saved } = await reader.api.command<Preference & { replayed: boolean }>(
      'launch-books-reader:choose', { method: 'PUT', path, body });
    expect(replayed).toBe(false);
    expect(saved).toMatchObject({ work: corpus.work, version: 1, language: 'en', edition: body.edition });
    // A fresh API client/session read corresponds to a page reload, with no client-local state.
    expect(await (await readerFor(first)).api.read(readPath)).toMatchObject(saved);
    expect(await reader.api.command('launch-books-reader:choose', { method: 'PUT', path, body }))
      .toMatchObject({ ...saved, replayed: true });
    await expect(reader.api.command('launch-books-reader:stale', { method: 'PUT', path, body: {
      ...body, edition: { kind: 'release', resource: corpus.editions[1]!.release, revision: corpus.editions[1]!.revision },
    } })).rejects.toThrow('HTTP 409');
    expect(await reader.api.read(readPath)).toMatchObject(saved);
    expect(await isolatedReader.api.read(`${path}?actingSubject=${encodeURIComponent(isolatedReader.agent)}`)).toBeNull();
    expect(corpus.editions.map(item => item.sourceFormat).filter(Boolean).sort())
      .toEqual(['Audiobook', 'E-book', 'paperback']);
  } finally {
    const failures: unknown[] = [];
    for (const target of targets) {
      try { await driver.stop(target!); } catch (error) { failures.push(error); }
    }
    if (!relayClosed) { try { await relay.end(); } catch (error) { failures.push(error); } }
    if (!sourceClosed) { try { await source.stop(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Launch corpus cleanup failed');
  }
}, 420_000);
