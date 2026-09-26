import { AwsClient } from 'aws4fetch';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { PROFILE } from '../../../services/main/src/modules/work/activate.ts';
import { type FixtureWork, RecordDigest, corpusWorks, mainComponentState, sha256,
  workComponentState } from '../corpus.ts';
import type { FixtureOwner } from './types.ts';

/** Main's Work revision namespace in the semantic bucket (services/main/src/index.ts). */
export const WORK_OBJECT_PREFIX = 'semantic/work/';
const UPLOAD_CONCURRENCY = 64;

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
    const store = new S3ImmutableObjects({ endpoint: target.apps.MAIN_S3_ENDPOINT!,
      bucket: target.apps.MAIN_S3_BUCKET!, region: target.apps.MAIN_S3_REGION!,
      accessKeyId: target.apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: target.apps.MAIN_S3_SECRET_KEY!,
      prefix: WORK_OBJECT_PREFIX });
    await store.initialize();
    const { signer, bucketUrl } = s3(target.apps);
    const works = corpusWorks(corpus);
    let bytes = 0;
    let objects = 0;
    // Conditional create plus a server-verified SHA-256; the build's verify step and
    // the restore smoke read samples back through Main's own object reader.
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
    return { elapsedMs: performance.now() - started, detail: { objects, bytes } };
  },
  async verify(_corpus, target) {
    // Build-time only: one namespace listing proves the exact object count.
    const { signer, bucketUrl } = s3(target.apps);
    let listed = 0;
    let token: string | undefined;
    do {
      const url = new URL(bucketUrl);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', `${WORK_OBJECT_PREFIX}sha256/`);
      url.searchParams.set('max-keys', '1000');
      if (token) url.searchParams.set('continuation-token', token);
      const response = await signer.fetch(url.toString());
      const body = await response.text();
      if (!response.ok) throw new Error(`fixture object listing failed (${response.status})`);
      listed += body.match(/<Key>/g)?.length ?? 0;
      token = /<IsTruncated>true<\/IsTruncated>/.test(body)
        ? body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
    } while (token);
    return { object: listed };
  },
};
