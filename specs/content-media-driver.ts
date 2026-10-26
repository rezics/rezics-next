import type { DocumentSnapshot } from '../packages/document/src/types';

/**
 * Test-only binding: CONTENT_MEDIA_DRIVER is an absolute path or file URL exporting
 * createContentMediaDriver(): Promise<ContentMediaDriver>. Each call owns isolated
 * migrated PostgreSQL fixtures, real Access/JWT personas and deterministic local
 * storage-port bytes. close removes rows, credentials, files and installed faults.
 *
 * Commands must use actual createKernel.handle; jobs call actual production job
 * functions. The adapter only maps transport/results and inspects authoritative
 * rows, receipts, storage and executed statements. It must not implement media
 * transitions, claim transactions, collection selection or the image ladder.
 * No in-memory product model, mocked authorization or alternate SQL evaluator.
 *
 * Web owns byte transport. placeOriginal is fixture setup at the storage port,
 * never a Worker implementation. complete exercises the public upload-complete
 * boundary with the uploader's own verified token and reservation/container binding.
 * Site Worker is the website BFF and confidential OAuth client: private_key_jwt
 * keys exist only in Worker. Person access/refresh tokens live only in Worker
 * server sessions; the browser holds only a session cookie. Real Auth issues these tokens using
 * private_key_jwt client authentication, never handwritten JWTs in this suite.
 * 'worker' selects uploader-sub, client_id=website credentials with media:complete;
 * 'author' is the same uploader with an ordinary token lacking that scope.
 * Only the website client registration permits media:complete. 'other-worker'
 * has a real different sub with the same website client and scope. None is a
 * separate Worker actor or client-sub token; no token exchange or RFC8693.
 * Creation on the container is authorized at reserve. Completion matches the
 * reservation uploader to verified sub, the container, measured bytes and SHA256.
 * Its formula authority and media:complete scope are independent of media:create.
 * Every command authorizes at authoritative T before consulting its receipt.
 */
export type Persona = 'author' | 'other' | 'anonymous' | 'suspended' | 'moderator' | 'worker' | 'other-worker' | 'job';
export type Outcome = 'permitted' | 'denied' | 'invalid';
export interface Container {
  id: string;
  route: number;
  partition: number;
}
export interface Reservation {
  requestId: string;
  containerId: string;
  purpose: string;
  type: string;
  length: number;
  sha256?: string | undefined;
}
export interface Media {
  id: string;
  key: string;
  containerId: string;
  uploaderId: string;
  route: number;
  partition: number;
  purpose: string;
  type: string;
  length: number;
  sha256: string | null;
  state: 'reserved' | 'uploaded' | 'available' | 'rejected';
  erased: boolean;
  createdAt: string;
  claimedAt: string | null;
  decision: string | null;
}
export type Reserved = { outcome: 'permitted'; media: Media } | { outcome: 'denied' | 'invalid' };
export interface Completion {
  /** Command receipt identity; transport metadata, not a completion body field. */
  requestId: string;
  reservationRequestId: string;
  containerId: string;
  byteCount: number;
  sha256: string;
}
export interface ReferenceCommand {
  requestId: string;
  containerId: string;
  kind: 'post' | 'revision';
  document: DocumentSnapshot;
  /** Explicit author media references, without changing the document schema. */
  mediaIds: string[];
  untrusted?: { claimedAt?: string; state?: 'available'; uploaderId?: string };
}
export type ImageFixture = 'landscape' | 'oriented-gps' | 'tiny' | 'over-pixel' | 'truncated' | 'malformed';
export interface Source {
  bytes: Uint8Array;
  sha256: string;
  type: string;
  orientedWidth: number;
  orientedHeight: number;
  /** Decoded source metadata, including EXIF orientation and GPS for oriented-gps. */
  metadata: string[];
}
export interface Derivative {
  key: string;
  bytes: Uint8Array;
}
export type Download =
  | { outcome: 'denied' }
  | {
      outcome: 'permitted';
      key: string;
      representation: 'original' | 'derivative';
      sha256: string;
    };
export interface Inspection {
  media: Media[];
  /** Durable committed post/revision references, not adapter-maintained counts. */
  references: { commandId: string; mediaIds: string[]; partition: number }[];
  receipts: { requestId: string; effects: number }[];
  storage: { key: string; sha256: string }[];
}
export interface CollectionRun {
  outcome: Outcome;
  /** Observed production SQL executions, including bound partition and global-scan evidence. */
  selections: { partition: number; bound: boolean; globalScan: boolean }[];
}
export interface ContentMediaDriver {
  readonly authorId: string;
  /** Existing public thread, same-partition different container, different-partition route. */
  readonly containers: { thread: Container; sibling: Container; remote: Container };
  /**
   * Author has media:create and reference authority on all three existing
   * containers via parent anchored grants,
   * never an object/new-ID grant. Other has no grant initially. Moderator has
   * moderation rights but cannot impersonate author. Fixtures include valid
   * post/revision targets in each container. All personas use real credentials.
   */
  reserve(as: Persona, input: Reservation): Promise<Reserved>;
  /** Observe real Access/SQL execution, not a declaration supplied by the adapter. */
  reservationEvidence(requestId: string): Promise<{
    action: string;
    anchorId: string;
    partition: number;
    anchored: boolean;
    authoritativeTime: string;
    newObjectGrant: boolean;
  }>;
  /**
   * HTTP body is {containerId,reservationRequestId,byteCount,sha256}; uploader is
   * verified sub, never trusted body input. Resolve media by reservation+container.
   * Reservation/Media length/type are test-only mappings of HTTP byteCount/mediaType.
   */
  complete(as: Persona, input: Completion, untrusted?: Record<string, unknown>): Promise<Outcome>;
  /**
   * Observe claims from the actual JWT verifier for this persona's request, even
   * if authorization denied it. Website ID comes from real Auth registration.
   * No adapter constants, decoded-but-unverified tokens or fabricated evidence.
   */
  authenticationEvidence(
    as: 'author' | 'worker' | 'other-worker',
    requestId: string,
  ): Promise<{
    sub: string;
    clientId: string;
    scopes: string[];
    registeredWebsiteClientId: string;
  }>;
  process(as: Persona, objectId: string): Promise<Outcome>;
  reference(as: Persona, input: ReferenceCommand): Promise<Outcome>;
  download(
    as: Persona,
    objectId: string,
    representation: 'original' | 'derivative',
    conditional?: { ifNoneMatch: string },
  ): Promise<Download>;
  collect(as: Persona, partition: number): Promise<CollectionRun>;
  inspect(): Promise<Inspection>;
  derivatives(objectId: string): Promise<Derivative[]>;
  /**
   * Decode the returned bytes with real Sharp, never infer metadata from key/row.
   * Map HEIF with AV1 compression to avif; metadata lists embedded EXIF, GPS,
   * XMP, ICC and orientation tags (not structural format/dimension fields).
   */
  decode(bytes: Uint8Array): Promise<{
    format: 'avif' | 'webp';
    width: number;
    height: number;
    metadata: string[];
  }>;
  /** Actual production Sharp invocation options, observed at its dependency boundary. */
  processingEvidence(objectId: string): Promise<{
    sharpVersion: string;
    limitInputPixels: number;
    failOn: string;
    autoOrient: boolean;
  }>;
  /**
   * Real encoded images: landscape 3000x1500; oriented-gps stored 1200x800
   * with orientation 6 (display 800x1200), EXIF/GPS/XMP; tiny 127x61 with
   * EXIF/GPS. Over-pixel decodes to >40M pixels, truncated has an intact
   * image header but missing payload. No permanent malicious samples.
   */
  source(kind: ImageFixture): Promise<Source>;
  placeOriginal(objectId: string, bytes: Uint8Array): Promise<void>;
  /** Fixture controls only; preserve receipts and sessions except explicit credential replacement. */
  setTime(instant: string): Promise<void>;
  setCreatedAt(objectId: string, instant: string): Promise<void>;
  grantParent(as: 'other', containerId: string): Promise<void>;
  /** Revoke only uploader media:create on this parent; preserve all other authority. */
  revokeMediaCreate(containerId: string): Promise<void>;
  /**
   * Replace only worker credentials with a valid Auth-issued same-sub/client token
   * lacking media:complete. Preserve other scopes/formula authority, parent-create
   * grants, reservation, bytes and receipts; author credentials stay valid.
   */
  removeWebsiteCompletionScope(): Promise<void>;
  /** Revoke only the author's actual post/revision command authority on this container. */
  revokeReferenceAuthority(containerId: string, kind: 'post' | 'revision'): Promise<void>;
  setParentVisibility(value: 'private' | 'taken-down'): Promise<void>;
  erase(objectId: string): Promise<void>;
  /** One-shot failure after real reference writes but before commit; maps to denied and rolls back. */
  failReferenceCommit(): Promise<void>;
  failNextStorageDelete(key: string): Promise<void>;
  /**
   * Barrier at the actual collection selection/deletion boundary and actual
   * claim transaction; force both lock orderings in fresh fixtures. No sleep
   * race or simulated state change. Returns only once both operations settle.
   */
  raceClaimCollection(
    input: ReferenceCommand,
    objectId: string,
    first: 'claim' | 'collection',
  ): Promise<{ claim: Outcome; collection: CollectionRun }>;
  close(): Promise<void>;
}
