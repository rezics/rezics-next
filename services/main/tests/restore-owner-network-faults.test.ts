import { expect, spyOn, test } from 'bun:test';
import { AwsClient } from 'aws4fetch';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import {
  S3ImmutableObjects,
  withoutVerifiedImmutableObjectCache,
  type ImmutableObjects,
} from '../src/infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { readExactModelGeneration } from '../src/modules/semantic/model-custody.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import {
  hash,
  prepareWorkComponent,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { readWorkComponentState } from '../src/modules/work/history.ts';
import { isRestoreTransientFailure } from '../src/modules/work/restore-lineage.ts';

const sites = [
  'immutable GET',
  'immutable HEAD',
  'immutable response body',
  'history manifest GET',
  'model manifest GET',
  'model shape GET',
] as const;

for (const site of sites) {
  for (const code of ['ECONNRESET', '57P01'] as const) {
    test(`${site}: ${code} survives actual network and model wrappers even with a complete local fallback`, async () => {
      const data = new Map<string, Uint8Array>();
      const memory: ImmutableObjects = {
        put: async (bytes) => {
          const key = hash(bytes);
          data.set(key, bytes);
          return key;
        },
        get: async (key) => data.get(key)!,
      };
      const shape = Buffer.from('retained shape');
      const shapeDigest = await memory.put(shape);
      const manifest = Buffer.from(
        JSON.stringify({
          commandModule: COMMAND_MODULE_VERSION,
          profiles: [
            { id: 'retained-profile-v1', sha256: shapeDigest, file: 'shapes/retained.ttl' },
          ],
        }),
      );
      const manifestDigest = await memory.put(manifest);
      const generation = `urn:rezics:model-generation:${manifestDigest}`;
      const anchorDigest = await prepareWorkComponent(
        memory,
        generation,
        {
          modelManifestSha256: manifestDigest,
          commandModule: COMMAND_MODULE_VERSION,
          entailment: 'none',
        },
        PROFILES.generation,
      );
      const temp = resolve(import.meta.dir, '../../../.temp');
      mkdirSync(temp, { recursive: true });
      const directory = mkdtempSync(join(temp, 'restore-owner-network-'));
      for (const [key, bytes] of data) writeFileSync(join(directory, key), bytes);
      const failure = Object.assign(new Error('owner unavailable'), { code });
      const store = new S3ImmutableObjects({
        endpoint: 'http://unused.invalid',
        bucket: 'restore-custody',
        accessKeyId: 'fixture',
        secretAccessKey: 'fixture',
        prefix: 'work/custody/',
      });
      let hits = 0;
      const network = spyOn(AwsClient.prototype, 'fetch').mockImplementation(async (input) => {
        const key = String(input).slice(-64);
        const target =
          site === 'model manifest GET'
            ? manifestDigest
            : site === 'model shape GET'
              ? shapeDigest
              : anchorDigest;
        if (key === target) {
          hits++;
          if (site === 'immutable response body')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(failure);
                },
              }),
            );
          throw failure;
        }
        const bytes = data.get(key);
        return bytes ? new Response(Buffer.from(bytes)) : new Response(null, { status: 404 });
      });
      class ModelGraph extends FusekiClient {
        override async query(): Promise<SparqlResult> {
          return {
            results: {
              bindings: [
                {
                  manifest: { type: 'uri', value: `urn:rezics:sha256:${anchorDigest}` },
                  commandModule: { type: 'literal', value: COMMAND_MODULE_VERSION },
                },
              ],
            },
          };
        }
      }
      const env = {
        fuseki: new ModelGraph('http://unused.invalid'),
        workObjects: store,
        objectDirectory: directory,
        lineage: { dataEpoch: 'retained', routingEpoch: '1' },
      } as WorkActivationEnvironment;
      const operation: () => Promise<unknown> =
        site === 'immutable HEAD'
          ? () => store.probe(anchorDigest)
          : site.startsWith('immutable')
            ? () => store.get(anchorDigest)
            : site === 'history manifest GET'
              ? () =>
                  readWorkComponentState(
                    env,
                    `urn:rezics:sha256:${anchorDigest}`,
                    generation,
                    PROFILES.generation,
                  )
              : () => readExactModelGeneration(env, generation);
      try {
        let caught: unknown;
        try {
          await withoutVerifiedImmutableObjectCache(operation);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(isRestoreTransientFailure(caught)).toBe(true);
        let root = caught;
        while (root instanceof Error && root.cause !== undefined) root = root.cause;
        expect(root).toBe(failure);
        expect(hits).toBe(1);
      } finally {
        network.mockRestore();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
