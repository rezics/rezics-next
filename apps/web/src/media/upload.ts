import type { DigestStream } from '@cloudflare/workers-types';
import { viewerCredential } from '../session/request.ts';
import { completeReservation, dependencyUnavailable, mediaClient, problem, readReservation } from './kernel.ts';
import type { MediaEnv } from './index.ts';

const invalidRequest = () => problem(400, 'invalid_request', 'Invalid Request');
const tooLarge = () => problem(413, 'invalid_request', 'Invalid Request');

export async function upload(request: Request, id: string, env: MediaEnv): Promise<Response> {
  const credential = viewerCredential(request);
  const client = mediaClient(env.KERNEL_ORIGIN);
  const media = await readReservation(client, id, credential);
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

  let measured = 0;
  const fixed = new FixedLengthStream(media.byteCount);
  const digest = new (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream('SHA-256');
  const digestWriter = digest.getWriter();
  let digestFailed = false;
  const controller = new AbortController();
  let writeBegan = false;
  try {
    const counted = request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, stream) {
          measured += chunk.byteLength;
          if (measured > media.byteCount) throw tooLarge();
          try {
            await digestWriter.write(chunk);
          } catch (error) {
            digestFailed = true;
            throw error;
          }
          stream.enqueue(chunk);
        },
        async flush() {
          if (measured < media.byteCount) throw invalidRequest();
          try {
            await digestWriter.close();
          } catch (error) {
            digestFailed = true;
            throw error;
          }
        },
      }),
    );
    const pumping = counted.pipeTo(fixed.writable, { signal: controller.signal });
    const hashing = Promise.all([pumping, digest.digest]);
    writeBegan = true;
    const writing = env.MEDIA.put(media.key, fixed.readable, {
      httpMetadata: { contentType: media.mediaType },
      ...(media.sha256 === null ? {} : { sha256: media.sha256 }),
    });
    // Wait for storage to finish before cleanup, so a late put cannot restore failed bytes.
    const [pumped, hashed, written] = await Promise.allSettled([pumping, hashing, writing]);
    if (digestFailed) throw dependencyUnavailable();
    if (measured > media.byteCount) throw tooLarge();
    if (measured < media.byteCount || pumped.status === 'rejected') throw invalidRequest();
    if (hashed.status === 'rejected') throw dependencyUnavailable();
    const sha256 = Array.from(new Uint8Array(hashed.value[1]), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (media.sha256 !== null && sha256 !== media.sha256) throw invalidRequest();
    if (written.status === 'rejected' || written.value === null) throw dependencyUnavailable();
    const completion = await completeReservation(client, id, credential, {
      containerId: media.containerId,
      reservationRequestId: media.reservationRequestId,
      byteCount: measured,
      sha256,
    });
    return Response.json(completion, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    controller.abort();
    await digestWriter.abort(error).catch(() => {});
    if (writeBegan) await env.MEDIA.delete(media.key);
    throw error;
  }
}
