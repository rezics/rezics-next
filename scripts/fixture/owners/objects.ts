import { AwsClient } from 'aws4fetch';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { PROFILE } from '../../../services/main/src/modules/work/activate.ts';
import { type FixtureWork, RecordDigest, corpusWorks, mainComponentState, sha256, workAt,
  workComponentState } from '../corpus.ts';
import type { FixtureOwner, LoadTarget } from './types.ts';

/** Main's Work revision namespace in the semantic bucket (services/main/src/index.ts). */
export const WORK_OBJECT_PREFIX = 'semantic/work/';
/** RustFS 1.0.0 saturated near 1,450 PUT/s here at 64, 192 or no checksum alike. */
const UPLOAD_CONCURRENCY = 64;
const VERIFY_SAMPLES = 256;
const accepted = new WeakMap<LoadTarget, number>();

interface StoredObject { digest: string; bytes: Buffer<ArrayBuffer> }

function component(componentIri: string, state: Record<string, unknown>) {
  // Byte layout of prepareWorkComponent, so imported and command-created revisions match.
  const payloadBytes = Buffer.from(JSON.stringify({ format: 'rezics-component-v1',
    component: componentIri, state }));
  const payload = { digest: sha256(payloadBytes), bytes: payloadBytes };
  const manifestBytes = Buffer.from(JSON.stringify({ format: 'rezics-manifest-v1',
    component: componentIri, payload: `sha256:${payload.digest}`, payloadBytes: payloadBytes.length,
    mediaType: 'application/json', model: PROFILE, shape: PROFILE }));
  return { payload, manifest: { digest: sha256(manifestBytes), bytes: manifestBytes } };
}

export function componentObjects(work: FixtureWork): {
  workManifest: StoredObject; mainManifest: StoredObject; all: StoredObject[] } {
  const workComponent = component(work.work, workComponentState(work));
  const mainComponent = component(work.mainVersion, mainComponentState(work));
  return { workManifest: workComponent.manifest, mainManifest: mainComponent.manifest,
    all: [workComponent.payload, workComponent.manifest, mainComponent.payload, mainComponent.manifest] };
}

function objectStore(apps: Record<string, string>): S3ImmutableObjects {
  return new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
    region: apps.MAIN_S3_REGION!, accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: apps.MAIN_S3_SECRET_KEY!, prefix: WORK_OBJECT_PREFIX });
}

function s3(apps: Record<string, string>) {
  return { signer: new AwsClient({ accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: apps.MAIN_S3_SECRET_KEY!, service: 's3', region: apps.MAIN_S3_REGION!, retries: 3 }),
  bucketUrl: `${new URL(apps.MAIN_S3_ENDPOINT!).origin}/${apps.MAIN_S3_BUCKET}` };
}

export const objectsOwner: FixtureOwner = {
  name: 'objects',
  generator: 'objects-work-components-v1',
  phase: 'online',
  compatibilityInputs: () => ({ prefix: WORK_OBJECT_PREFIX, model: PROFILE }),
  summarize(corpus) {
    const digest = new RecordDigest();
    for (const work of corpusWorks(corpus)) {
      for (const object of componentObjects(work).all) digest.add('object', object.digest);
    }
    return digest.finish();
  },
  async load(corpus, target) {
    const started = performance.now();
    await objectStore(target.apps).initialize();
    const { signer, bucketUrl } = s3(target.apps);
    const works = corpusWorks(corpus);
    let bytes = 0;
    let objects = 0;
    // Conditional create plus a server-verified SHA-256; verify and the restore smoke
    // read samples back through Main's own digest-checking object reader.
    const worker = async () => {
      for (let next = works.next(); !next.done; next = works.next()) {
        for (const object of componentObjects(next.value).all) {
          const response = await signer.fetch(`${bucketUrl}/${WORK_OBJECT_PREFIX}sha256/${object.digest}`, {
            method: 'PUT', body: object.bytes, aws: { allHeaders: true },
            headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*',
              'x-amz-checksum-sha256': Buffer.from(object.digest, 'hex').toString('base64') } });
          await response.arrayBuffer();
          if (!response.ok && response.status !== 412 && response.status !== 409) {
            throw new Error(`fixture object upload failed (${response.status})`);
          }
          bytes += object.bytes.length;
          objects++;
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    accepted.set(target, objects);
    return { elapsedMs: performance.now() - started, detail: { objects, bytes } };
  },
  async verify(corpus, target) {
    // A 400,000-key RustFS prefix listing took 588 s, so the count is the per-request
    // acknowledgements and storage is checked by exact reads of evenly spaced Works.
    const acknowledged = accepted.get(target);
    if (acknowledged === undefined) throw new Error('fixture objects were not loaded into this target');
    const store = objectStore(target.apps);
    const step = Math.max(1, Math.floor(corpus.works / VERIFY_SAMPLES));
    for (let index = 0; index < corpus.works; index += step) {
      for (const object of componentObjects(workAt(corpus, index)).all) await store.get(object.digest);
    }
    return { object: acknowledged };
  },
};
