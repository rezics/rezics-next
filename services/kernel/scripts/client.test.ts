import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { clientDeclarationCacheDirectory, clientDeclarations, withOrderReconcileAuthorization } from './client.ts';

const repository = resolve(import.meta.dir, '../../..');

test('incremental client declarations match a clean emit after one source file changes', () => {
  mkdirSync(resolve(repository, '.temp'), { recursive: true });
  const fixture = mkdtempSync(resolve(repository, '.temp', 'kernel-client-test-'));
  const kernel = resolve(fixture, 'services/kernel');
  const incrementalCache = resolve(fixture, '.temp/incremental');
  const cleanCache = resolve(fixture, '.temp/clean');
  try {
    mkdirSync(resolve(kernel, 'src/http'), { recursive: true });
    writeFileSync(
      resolve(kernel, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'preserve', moduleResolution: 'bundler', strict: true },
        include: ['src'],
      }),
    );
    writeFileSync(resolve(kernel, 'src/http/kernel.ts'), "export type { Response } from './response';\n");
    writeFileSync(resolve(kernel, 'src/http/request.ts'), 'export interface Request { id: string }\n');
    const response = resolve(kernel, 'src/http/response.ts');
    writeFileSync(response, 'export interface Response { message: string }\n');
    const checkoutCache = clientDeclarationCacheDirectory(fixture, kernel);

    clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: incrementalCache });
    writeFileSync(response, 'export interface Response { text: string }\n');
    expect(clientDeclarationCacheDirectory(fixture, kernel)).toBe(checkoutCache);
    const incremental = clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: incrementalCache });
    const clean = clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: cleanCache });

    expect([...incremental.entries()]).toEqual([...clean.entries()]);
    expect(readFileSync(resolve(incrementalCache, 'tsconfig.tsbuildinfo'), 'utf8').length).toBeGreaterThan(0);
    const config = JSON.parse(readFileSync(resolve(incrementalCache, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: {
        rootDir: string;
        outDir: string;
        noEmit: boolean;
        declaration: boolean;
        emitDeclarationOnly: boolean;
        incremental: boolean;
        tsBuildInfoFile: string;
      };
    };
    expect(config.compilerOptions).toEqual({
      rootDir: kernel,
      outDir: resolve(incrementalCache, 'emit'),
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      incremental: true,
      tsBuildInfoFile: resolve(incrementalCache, 'tsconfig.tsbuildinfo'),
    });
    writeFileSync(resolve(kernel, 'src/http/extra.ts'), 'export type Extra = string;\n');
    expect(clientDeclarationCacheDirectory(fixture, kernel)).not.toBe(checkoutCache);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the generated order reconcile call includes bearer authorization, idempotency, and a queued response', () => {
  const source = `                $reconcile: {
                    post: {
                        body: object;
                        params: {
                            orderId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            202: {
                                orderId: string;
                                reconciliation: "queued";
                            };
                        };
                    };
                };`;
  const generated = withOrderReconcileAuthorization(source);
  expect(generated).toContain('authorization: string;');
  expect(generated).toContain('"idempotency-key": string;');
  expect(generated).toContain('body: object;');
  expect(generated).toContain('reconciliation: "queued"');
  expect(generated.indexOf('authorization: string;')).toBeLessThan(generated.indexOf('"idempotency-key": string;'));
  expect(withOrderReconcileAuthorization(generated)).toBe(generated);
});
