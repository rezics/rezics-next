import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEYS } from '../../scripts/semantic-first-public-inventory.ts';
import {
  semanticFirstPublicCases,
  type SemanticFirstPublicResult,
  type SemanticFirstPublicSession,
} from '../../scripts/semantic-first-public-cases.ts';
import { summarizeBoundaryRequest, type NativeObservation } from '../../scripts/semantic-first-public-request.ts';
import { nativeAfterAll, nativeBeforeAll, nativeTest, NativeTestLifecycle } from './lifecycle.ts';
import { prepareSemanticFirstPublicHost } from './semantic-first-public-host.ts';

const lifecycle = new NativeTestLifecycle('original 31 Semantic cases on one native Web host');
const evidenceDir = resolve(import.meta.dir, '../../../../.temp/semantic-first-public-native-host');
const root = resolve(import.meta.dir, '../../../..');
const trace: NativeObservation[] = [];
const results: SemanticFirstPublicResult[] = [];
let session: SemanticFirstPublicSession;
let revision: string | null = null;
let phase = 'preparing';
let editorAccountId: string;

async function retain() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(evidenceDir, 'evidence.json'),
    JSON.stringify(
      {
        revision,
        utc: new Date().toISOString(),
        scope: 'original-full-31-native-host',
        phase,
        editorAccountId,
        total: FIRST_PUBLIC_JOURNEYS.length,
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
    );
    session = prepared.session;
    editorAccountId = prepared.editorAccountId;
  } finally {
    await retain();
  }
});
nativeAfterAll(lifecycle, 240_000);

nativeTest(
  'all original Semantic catalogue and Zone cases reuse the ordinary native host',
  720_000,
  async () => {
    for (const item of semanticFirstPublicCases(session)) {
      phase = item.id;
      await retain();
      results.push(await item.run());
      await retain();
    }
    phase = 'completed';
    await retain();
    if (results.length !== FIRST_PUBLIC_JOURNEYS.length || results.some((row) => row.status === 'Failing'))
      throw new Error(
        `Original Semantic cases passed ${results.filter((row) => row.status === 'Passing').length}/${FIRST_PUBLIC_JOURNEYS.length}`,
      );
  },
  lifecycle,
);
