import type { DigestStream } from '@cloudflare/workers-types';
import { viewerCredential } from '../session/request.ts';
import {
  completeReservation,
  dependencyUnavailable,
  mediaClient,
  MediaProblem,
  problem,
  readReservation,
} from './kernel.ts';
import type { MediaEnv } from './index.ts';

const invalidRequest = () => problem(400, 'invalid_request', 'Invalid Request');
const tooLarge = () => problem(413, 'invalid_request', 'Invalid Request');

type FailureKind = 'request' | 'pump' | 'digest' | 'storage';
type TransferFailure = { kind: FailureKind; error: unknown };
type Outcome = { ok: true; value?: unknown } | { ok: false; error: unknown };

function requestAbortError(): DOMException {
  return new DOMException('The request was aborted', 'AbortError');
}

// R2 refuses a body whose SHA-256 differs from the declared digest. That is the caller's bytes, not a storage outage.
const checksumMismatch = (error: unknown): boolean =>
  error instanceof Error && /checksum you specified did not match/u.test(error.message);

function transferProblem(failure: TransferFailure): Error {
  if (failure.kind === 'pump') return failure.error instanceof MediaProblem ? failure.error : invalidRequest();
  if (failure.kind === 'storage' && checksumMismatch(failure.error)) return invalidRequest();
  return dependencyUnavailable();
}

function rejectOutcome(error: unknown): Outcome {
  return { ok: false, error };
}

export async function upload(request: Request, id: string, env: MediaEnv): Promise<Response> {
  if (request.signal.aborted) throw dependencyUnavailable();
  const credential = viewerCredential(request);
  const client = mediaClient(env.KERNEL_ORIGIN);
  const media = await readReservation(client, id, credential);
  if (request.signal.aborted) throw dependencyUnavailable();
  if (media.state !== 'reserved') throw problem(409, 'invalid_request', 'Invalid Request');
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== media.mediaType) throw problem(415, 'invalid_request', 'Invalid Request');
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw invalidRequest();
    if (BigInt(length) > BigInt(media.byteCount)) throw tooLarge();
    if (BigInt(length) < BigInt(media.byteCount)) throw invalidRequest();
  }
  if (!request.body) throw invalidRequest();
  if (request.signal.aborted) throw dependencyUnavailable();

  let measured = 0;
  const fixed = new FixedLengthStream(media.byteCount);
  const digest = new (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream('SHA-256');
  const digestWriter = digest.getWriter();
  const controller = new AbortController();

  let writeBegan = false;
  let transferSettled = false;
  let transferComplete = false;
  let digestWriterReleased = false;
  let failure: TransferFailure | undefined;
  let digestAbort: Promise<void> = Promise.resolve();
  let storageReadCancellation: Promise<void> = Promise.resolve();
  let pumpingOutcome: Promise<Outcome> | undefined;
  let digestOutcome: Promise<Outcome> | undefined;
  let storageOutcome: Promise<Outcome> | undefined;
  let requestAbortListener: (() => void) | undefined;
  let signalFailure!: () => void;
  const failureSignal = new Promise<void>((resolve) => (signalFailure = resolve));

  const stop = (kind: FailureKind, error: unknown) => {
    if (failure) return;
    failure = { kind, error };
    signalFailure();
    controller.abort(error);
    // A rejected put may leave no reader to release a pending FixedLengthStream write.
    if (kind === 'storage' && !fixed.readable.locked) storageReadCancellation = fixed.readable.cancel(error);
    try {
      digestAbort = digestWriter.abort(error).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // The transfer error remains authoritative if aborting an already-closed digest fails.
    }
  };

  const joinStarted = async () => {
    const started = [pumpingOutcome, digestOutcome, storageOutcome].filter(
      (participant): participant is Promise<Outcome> => participant !== undefined,
    );
    await Promise.all(started);
    await digestAbort;
    await storageReadCancellation;
  };

  const releaseDigestWriter = (preserveFailure: boolean) => {
    if (digestWriterReleased) return;
    digestWriterReleased = true;
    try {
      digestWriter.releaseLock();
    } catch (error) {
      if (!preserveFailure) throw error;
    }
  };

  try {
    digestOutcome = digest.digest.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => {
        stop('digest', error);
        return rejectOutcome(error);
      },
    );

    requestAbortListener = () => {
      if (!transferComplete) stop('request', requestAbortError());
    };
    request.signal.addEventListener('abort', requestAbortListener, { once: true });
    if (request.signal.aborted) requestAbortListener();

    if (failure) {
      await joinStarted();
      transferSettled = true;
      throw transferProblem(failure);
    }

    const reader = request.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(stream) {
          let item: Awaited<ReturnType<typeof reader.read>>;
          try {
            item = await reader.read();
          } catch (error) {
            reader.releaseLock();
            stop('pump', error);
            throw error;
          }
          if (item.done) {
            reader.releaseLock();
            stream.close();
          } else stream.enqueue(item.value);
        },
        cancel(reason) {
          return reader.cancel(reason).finally(() => reader.releaseLock());
        },
      },
      { highWaterMark: 0 },
    );
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, stream) {
          measured += chunk.byteLength;
          if (measured > media.byteCount) {
            const error = tooLarge();
            stop('pump', error);
            throw error;
          }
          try {
            await digestWriter.write(chunk);
          } catch (error) {
            stop('digest', error);
            throw error;
          }
          stream.enqueue(chunk);
        },
        async flush() {
          if (measured < media.byteCount) {
            const error = invalidRequest();
            stop('pump', error);
            throw error;
          }
          try {
            await digestWriter.close();
          } catch (error) {
            stop('digest', error);
            throw error;
          }
        },
      }),
    );
    const pumping = counted.pipeTo(fixed.writable, { signal: controller.signal });
    pumpingOutcome = pumping.then(
      () => ({ ok: true }),
      (error: unknown) => {
        stop('pump', error);
        return rejectOutcome(error);
      },
    );

    let writing: Promise<unknown>;
    try {
      writeBegan = true;
      writing = Promise.resolve(
        env.MEDIA.put(media.key, fixed.readable, {
          httpMetadata: { contentType: media.mediaType },
          ...(media.sha256 === null ? {} : { sha256: media.sha256 }),
        }),
      );
      storageOutcome = writing.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => {
          stop('storage', error);
          return rejectOutcome(error);
        },
      );
    } catch (error) {
      stop('storage', error);
      storageOutcome = Promise.resolve(rejectOutcome(error));
    }

    const participants = Promise.all([pumpingOutcome, digestOutcome, storageOutcome]);
    await Promise.race([participants, failureSignal]);
    const [pumped, hashed, written] = await participants;
    transferSettled = true;
    await digestAbort;
    await storageReadCancellation;
    if (request.signal.aborted && !failure) stop('request', requestAbortError());
    if (failure) throw transferProblem(failure);
    if (!pumped.ok) throw invalidRequest();
    if (!hashed.ok) throw dependencyUnavailable();
    if (!written.ok || written.value === null) throw dependencyUnavailable();

    const sha256 = Array.from(new Uint8Array(hashed.value as ArrayBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (measured !== media.byteCount) throw invalidRequest();
    if (media.sha256 !== null && sha256 !== media.sha256) throw invalidRequest();
    releaseDigestWriter(false);

    // From this point the transfer participants have all succeeded. A later disconnect does not undo the write.
    transferComplete = true;
    const completion = await completeReservation(client, id, credential, {
      containerId: media.containerId,
      reservationRequestId: media.reservationRequestId,
      byteCount: measured,
      sha256,
    });
    return Response.json(completion, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (!transferComplete && !transferSettled) {
      if (!failure) stop('request', error);
      await joinStarted();
      transferSettled = true;
    }
    releaseDigestWriter(true);
    // Native completion may have committed even when its response is lost. Keep the
    // completed transfer for native observation and exact-command recovery.
    if (writeBegan && !transferComplete) {
      try {
        await env.MEDIA.delete(media.key);
      } catch {
        // Cleanup is best-effort; preserve the transfer or completion error.
      }
    }
    throw error;
  } finally {
    if (requestAbortListener) request.signal.removeEventListener('abort', requestAbortListener);
  }
}
