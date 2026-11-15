import { expect, spyOn } from 'bun:test';
import { ACCESS_EVIDENCE_TTL_MS } from '../../../src/access/evidence-deadline.ts';
import * as reads from '../../../src/content/reads.ts';

/** Delay the foreign read before it mints its own current source evidence. */
export async function withDelayedHostedAttachment<T>(postId: string, run: () => Promise<T>): Promise<T> {
  const original = reads.readPostMetadata;
  let delayed = false;
  const read = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    if (!delayed && args[2] === postId) {
      delayed = true;
      await Bun.sleep(ACCESS_EVIDENCE_TTL_MS + 50);
    }
    return original(...args);
  });
  try {
    const result = await run();
    expect(delayed).toBe(true);
    return result;
  } finally {
    read.mockRestore();
  }
}
