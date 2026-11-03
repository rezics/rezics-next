import { sha256ShelfTypeDigest, type ShelfTypeDigest } from '../../../src/library/shelf-type-keys.ts';

const collisionDigest = Buffer.alloc(32, 0x53);

export function createShelfDigestCollisionScenario() {
  let forced = false;
  const digest: ShelfTypeDigest = (bytes) => (forced ? Buffer.from(collisionDigest) : sha256ShelfTypeDigest(bytes));
  return {
    digest,
    workerShelfTypeDigest: collisionDigest.toString('base64url'),
    forceTypeDigestCollision() {
      forced = true;
    },
  };
}
