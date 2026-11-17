import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEYS, type FirstPublicJourneyId } from '../../scripts/semantic-first-public-inventory.ts';
import {
  semanticFirstPublicCases,
  type SemanticFirstPublicResult,
  type SemanticFirstPublicSession,
} from '../../scripts/semantic-first-public-cases.ts';
import { summarizeBoundaryRequest, type NativeObservation } from '../../scripts/semantic-first-public-request.ts';
import { nativeAfterAll, nativeBeforeAll, nativeTest, NativeTestLifecycle } from './lifecycle.ts';
import type { NativeWebStack } from './stack.ts';
import { prepareSemanticFirstPublicHost } from './semantic-first-public-host.ts';

type OriginalSelection = {
  requested: readonly FirstPublicJourneyId[];
  dependencies: Partial<Record<FirstPublicJourneyId, readonly FirstPublicJourneyId[]>>;
};

/** Selection changes execution scope while preserving the original shared bodies and one native actor. */
export function registerSemanticFirstPublicHost(selection?: OriginalSelection) {
  const lifecycle = new NativeTestLifecycle(
    selection
      ? 'selected original Semantic cases on one native Web host'
      : 'original 31 Semantic cases on one native Web host',
  );
  const selectedIds = selection
    ? new Set([...selection.requested, ...Object.values(selection.dependencies).flat()])
    : new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.id));
  const requiresSearch = selectedIds.has('catalogue-browsing');
  const evidenceDir = resolve(import.meta.dir, '../../../../.temp/semantic-first-public-native-host');
  const root = resolve(import.meta.dir, '../../../..');
  const trace: NativeObservation[] = [];
  const results: SemanticFirstPublicResult[] = [];
  let session: SemanticFirstPublicSession;
  let revision: string | null = null;
  let phase = 'preparing';
  let editorAccountId: string;
  let searchWorker: NativeWebStack['searchWorker'];

  async function retain() {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(evidenceDir, 'evidence.json'),
      JSON.stringify(
        {
          revision,
          utc: new Date().toISOString(),
          scope: selection ? 'selected-original-native-host' : 'original-full-31-native-host',
          originalTotal: FIRST_PUBLIC_JOURNEYS.length,
          requestedIds: selection?.requested ?? FIRST_PUBLIC_JOURNEYS.map((row) => row.id),
          dependencies: selection?.dependencies ?? {},
          selectedIds: FIRST_PUBLIC_JOURNEYS.filter((row) => selectedIds.has(row.id)).map((row) => row.id),
          phase,
          serviceDependencies: requiresSearch ? ['search'] : [],
          searchWorker,
          editorAccountId,
          completed: results.filter((row) => row.status !== 'Aborted').length,
          aborted: results.filter((row) => row.status === 'Aborted').length,
          pages: session?.pages,
          total: selectedIds.size,
          passing: results.filter((row) => row.status === 'Passing').length,
          results,
          commands: trace.map(summarizeBoundaryRequest),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  }

  nativeBeforeAll(lifecycle, 600_000, async () => {
    await mkdir(resolve(evidenceDir, 'screenshots'), { recursive: true, mode: 0o700 });
    const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
    revision = source.exitCode === 0 ? source.stdout.toString().trim() : null;
    await retain();
    try {
      const prepared = await prepareSemanticFirstPublicHost(
        evidenceDir,
        revision ?? 'unavailable',
        trace,
        (stage) => (phase = stage),
        true,
        { search: requiresSearch },
      );
      session = prepared.session;
      session.observePage = retain;
      editorAccountId = prepared.editorAccountId;
      searchWorker = prepared.searchWorker;
    } finally {
      await retain();
    }
  });
  nativeAfterAll(lifecycle, 240_000);

  nativeTest(
    selection
      ? 'selected original Semantic cases reuse the ordinary native host'
      : 'all original Semantic catalogue and Zone cases reuse the ordinary native host',
    720_000,
    async (signal) => {
      session.signal = signal;
      try {
        for (const item of semanticFirstPublicCases(session)) {
          signal.throwIfAborted();
          if (!selectedIds.has(item.id)) continue;
          phase = item.id;
          await retain();
          results.push(await item.run());
          await retain();
        }
        signal.throwIfAborted();
      } catch (error) {
        phase = signal.aborted ? 'aborted' : 'interrupted';
        await retain();
        throw error;
      }
      phase = 'completed';
      await retain();
      if (results.length !== selectedIds.size || results.some((row) => row.status !== 'Passing'))
        throw new Error(
          `Original Semantic cases passed ${results.filter((row) => row.status === 'Passing').length}/${selectedIds.size}`,
        );
    },
    lifecycle,
  );
}
