import { nativeProofBatchDeadline, nativeProofDeclaration } from './acceptance.ts';
import { commandAsync } from './core.ts';
import { fusekiImageTag } from '../dev/fuseki-image.ts';
import { preserveReapEnvironment } from './container-reaper.ts';

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
