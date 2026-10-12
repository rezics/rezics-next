import { NATIVE_PROOF_PREPARATION_ERROR, nativeProofBatchDeadline, nativeProofDeclaration } from './acceptance.ts';
import { commandAsync, xmlForCommand, type Tier } from './core.ts';
import { fusekiImageTag } from '../dev/fuseki-image.ts';
import { preserveReapEnvironment } from './container-reaper.ts';
import { redactCommandOutput } from '../fixture/command-output.ts';

/** File results preserve the refusal and retry whole proofs, rather than grepping a synthetic title. */
export function nativeProofPreparationFailure(tier: Tier, files: readonly string[], error: unknown, elapsedMs: number): {
  detail: string; xml: string;
} {
  const kind = error instanceof Error && 'kind' in error ? `${String(error.kind)}: ` : '';
  const detail = redactCommandOutput(`${kind}${error instanceof Error ? error.message : String(error)}`);
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const selected = [...new Set(files)];
  const cases = selected.map(file => `<testcase name="Native proof preparation" file="${escape(file)}" time="${elapsedMs / 1000}">`
    + `<failure type="${NATIVE_PROOF_PREPARATION_ERROR}" message="${escape(detail)}" /></testcase>`).join('\n');
  const xml = selected.length
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(tier)}" tests="${selected.length}" failures="${selected.length}">${cases}</testsuite>\n`
    : xmlForCommand(tier, false, elapsedMs, detail);
  return { detail, xml };
}

export class NativeProofImageUnavailable extends Error {
  readonly kind = 'native-proof-image-unavailable';
  constructor(readonly image: string, readonly files: readonly string[], detail: string) {
    super(`build ${image} first before running ${files.join(', ')}: ${detail}`);
    this.name = 'NativeProofImageUnavailable';
  }
}

interface ImagePreparation {
  imageTag?: (root: string) => string;
  inspect?: (root: string, image: string) => Promise<{ ok: boolean; output: string }>;
}

/** Preflight is outside the proof's execution clock; a missing tag never reaches the test runner. */
export async function runPreparedNativeProofBatch<T>(root: string, files: readonly string[],
  ordinaryBudgetMs: number, execute: (budgetMs: number) => Promise<T>, preparation: ImagePreparation = {}): Promise<T> {
  const consumers = files.filter(file => nativeProofDeclaration(file)?.preparedImage === 'fuseki');
  if (consumers.length) {
    const image = (preparation.imageTag ?? fusekiImageTag)(root);
    const inspected = await (preparation.inspect ?? (async (directory, tag) =>
      commandAsync(directory, 'docker', ['image', 'inspect', '--format', '{{.Id}}', tag],
        10_000, preserveReapEnvironment(process.env))))(root, image);
    if (!inspected.ok) throw new NativeProofImageUnavailable(image, consumers, inspected.output);
  }
  return execute(nativeProofBatchDeadline(files, ordinaryBudgetMs));
}
