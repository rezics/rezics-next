import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  semanticFirstPublicCases,
  type SemanticFirstPublicSession,
  type SemanticFirstPublicResult,
} from '../../scripts/semantic-first-public-cases.ts';
import { summarizeBoundaryRequest, type NativeObservation } from '../../scripts/semantic-first-public-request.ts';
import { nativeAfterAll, nativeBeforeAll, nativeTest, NativeTestLifecycle } from './lifecycle.ts';
import { prepareSemanticFirstPublicHost } from './semantic-first-public-host.ts';

const lifecycle = new NativeTestLifecycle('original Semantic generic Book native Web host');
const evidenceDir = resolve(import.meta.dir, '../../../../.temp/semantic-first-public-native-host');
const evidencePath = resolve(evidenceDir, 'evidence.json');
const root = resolve(import.meta.dir, '../../../..');
const trace: NativeObservation[] = [];
let session: SemanticFirstPublicSession;
let sourceRevision: string | null = null;
let stage = 'preparing';
let editorAccountId: string;
let result: SemanticFirstPublicResult | null = null;

async function retain() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        revision: sourceRevision,
        utc: new Date().toISOString(),
        scope: 'original-generic-creation-native-host',
        phase: stage,
        editorAccountId,
        result,
        mountedSubject: session?.mountedSubject,
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
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  sourceRevision = revision.exitCode === 0 ? revision.stdout.toString().trim() : null;
  await retain();
  try {
    const prepared = await prepareSemanticFirstPublicHost(
      evidenceDir,
      sourceRevision ?? 'unavailable',
      trace,
      (value) => (stage = value),
    );
    session = prepared.session;
    editorAccountId = prepared.editorAccountId;
  } finally {
    await retain();
  }
});
nativeAfterAll(lifecycle, 240_000);

nativeTest(
  'original generic Semantic Book creation visits the signed form and anonymous reader',
  720_000,
  async () => {
    stage = 'original generic Book case';
    try {
      result = await semanticFirstPublicCases(session)
        .find((item) => item.id === 'generic-creation')!
        .run();
      stage = 'completed';
      if (result.status === 'Failing') throw new Error(result.failure?.actual ?? 'Original generic Book case failed');
    } finally {
      await retain();
    }
  },
  lifecycle,
);
