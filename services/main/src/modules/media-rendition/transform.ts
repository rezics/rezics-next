import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  checkSize,
  parseProfile,
  RENDITION_LIMITS,
  type ImageSize,
  type RenditionOutput,
  type RenditionPlan,
  type RenditionType,
} from './policy.ts';

export interface ImageTransformer {
  inspect(
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<ImageSize & { hasAlpha?: boolean }>;
  transform(
    bytes: Uint8Array,
    mediaType: string,
    plan: RenditionPlan,
    signal?: AbortSignal,
  ): Promise<RenditionOutput>;
  transformCrop(
    bytes: Uint8Array,
    mediaType: string,
    plans: readonly RenditionPlan[],
    signal?: AbortSignal,
  ): Promise<RenditionOutput[]>;
}
export class LocalImageTransformer implements ImageTransformer {
  constructor(private readonly timeoutMs: number = RENDITION_LIMITS.timeoutMs) {
    checkDeadline(timeoutMs);
  }
  async inspect(
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<ImageSize & { hasAlpha: boolean }> {
    return transformInProcess(bytes, mediaType, null, this.timeoutMs, signal);
  }
  async transform(
    bytes: Uint8Array,
    mediaType: string,
    plan: RenditionPlan,
    signal?: AbortSignal,
  ): Promise<RenditionOutput> {
    const result = await transformInProcess(bytes, mediaType, plan, this.timeoutMs, signal);
    if (!result.type) throw new Error('missing rendition type');
    return { ...result, type: result.type };
  }
  async transformCrop(
    bytes: Uint8Array,
    mediaType: string,
    plans: readonly RenditionPlan[],
    signal?: AbortSignal,
  ): Promise<RenditionOutput[]> {
    const output = await runTransform(bytes, mediaType, plans, this.timeoutMs, signal);
    return output.map((result) => {
      if (!result.type) throw new Error('missing rendition type');
      return { ...result, type: result.type };
    });
  }
}
function checkDeadline(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RENDITION_LIMITS.timeoutMs)
    throw new Error('invalid rendition deadline');
}
interface ProcessReport extends ImageSize {
  hasAlpha: boolean;
  type: RenditionType | null;
  byteLength: number;
  sha256: string | null;
}
function report(message: unknown, plan: RenditionPlan | null): ProcessReport {
  if (!message || typeof message !== 'object') throw new Error('invalid rendition report');
  const value = message as ProcessReport;
  checkSize(value);
  if (
    typeof value.hasAlpha !== 'boolean' ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.byteLength > RENDITION_LIMITS.bytes ||
    (plan
      ? value.type !== parseProfile(plan.profile).type ||
        value.width > parseProfile(plan.profile).width ||
        value.byteLength === 0 ||
        typeof value.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      : value.type !== null || value.byteLength !== 0 || value.sha256 !== null)
  )
    throw new Error('invalid rendition report');
  return value;
}

/** Injectable entry point is confined to fatal-exit/timeout tests. Requests and
 * configuration never choose an executable, codec arguments or filesystem path. */
export async function transformInProcess(
  bytes: Uint8Array,
  mediaType: string,
  plan: RenditionPlan | null,
  timeoutMs: number,
  signal?: AbortSignal,
  entryPoint = new URL('./transform-process.ts', import.meta.url),
): Promise<ImageSize & { bytes: Uint8Array; type: RenditionType | null; hasAlpha: boolean }> {
  const [result] = await runTransform(
    bytes,
    mediaType,
    plan ? [plan] : null,
    timeoutMs,
    signal,
    entryPoint,
  );
  return result!;
}

async function runTransform(
  bytes: Uint8Array,
  mediaType: string,
  plans: readonly RenditionPlan[] | null,
  timeoutMs: number,
  signal?: AbortSignal,
  entryPoint = new URL('./transform-process.ts', import.meta.url),
): Promise<
  Array<ImageSize & { bytes: Uint8Array; type: RenditionType | null; hasAlpha: boolean }>
> {
  checkDeadline(timeoutMs);
  signal?.throwIfAborted();
  if (
    !bytes.length ||
    bytes.length > RENDITION_LIMITS.bytes ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
  )
    throw new Error('invalid rendition input');
  if (plans) {
    if (
      !plans.length ||
      plans.length > RENDITION_LIMITS.candidates ||
      new Set(plans.map((plan) => plan.profile)).size !== plans.length ||
      plans.some((plan) => plan.crop !== plans[0]!.crop)
    )
      throw new Error('invalid rendition plans');
    for (const plan of plans) parseProfile(plan.profile);
  }
  let result: ProcessReport[] | undefined;
  let invalid = false;
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--smol',
      fileURLToPath(entryPoint),
      mediaType,
      JSON.stringify(plans),
    ],
    {
      env: {},
      stdin: bytes,
      stdout: 'pipe',
      stderr: 'ignore',
      ipc(message: unknown) {
        try {
          if (result) throw new Error('duplicate rendition result');
          if (!Array.isArray(message) || message.length !== (plans?.length ?? 1))
            throw new Error('invalid rendition reports');
          result = message.map((value, index) => report(value, plans?.[index] ?? null));
        } catch {
          invalid = true;
          child.kill('SIGKILL');
        }
      },
    },
  );
  let expired = false;
  const kill = () => {
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  const output = (async () => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for await (const chunk of child.stdout) {
        if (length + chunk.byteLength > RENDITION_LIMITS.bytes * (plans?.length ?? 0)) {
          invalid = true;
          kill();
          break;
        }
        length += chunk.byteLength;
        chunks.push(chunk);
      }
    } catch {
      invalid = true;
      kill();
    }
    return Buffer.concat(chunks, length);
  })();
  try {
    const [exit, data] = await Promise.all([child.exited, output]);
    if (
      expired ||
      signal?.aborted ||
      exit !== 0 ||
      invalid ||
      !result ||
      data.length !== result.reduce((sum, value) => sum + value.byteLength, 0)
    )
      throw new Error('local image transform unavailable');
    let offset = 0;
    return result.map((value) => {
      const bytes = data.subarray(offset, offset + value.byteLength);
      offset += value.byteLength;
      if (plans && createHash('sha256').update(bytes).digest('hex') !== value.sha256)
        throw new Error('local image transform unavailable');
      // Inspect returns no codec and no bytes; callers use only its dimensions and alpha.
      return {
        width: value.width,
        height: value.height,
        type: value.type,
        bytes,
        hasAlpha: value.hasAlpha,
      };
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
    if (child.exitCode === null) kill();
    await child.exited;
    await output;
  }
}
