import { expect, test } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { observePreviewException, readBundledWebStages, webReadinessPath } from '../scripts/bundled-web-startup.ts';

test('forwards only complete startup stages across stderr chunk boundaries', () => {
  const stages: string[] = [];
  const read = readBundledWebStages((stage) => stages.push(stage));
  read(Buffer.from('source [native-web-build] build\n[native-web-'));
  read(Buffer.from('build] render ssr\n[native-web-build] render ssr extra\n'));
  read(Buffer.from('x'.repeat(32_000)));
  read(Buffer.from('[native-web-build] listen\n[native-web-build] generate-bundle client\n'));
  read(Buffer.from('[native-web-build] render-failed ssr count=6759 code=MISSING_EXPORT\n'));
  read(Buffer.from('[native-web-build] graph-failed client count=1 code=private\n'));
  read(Buffer.from('[native-web-build] unknown\n[native-web-build] render private\n[native-web-build] preview'));
  expect(stages).toEqual(['render ssr', 'generate-bundle client', 'render-failed ssr count=6759 code=MISSING_EXPORT']);
});

test('reports the first matching preview exception and propagates every original error', () => {
  const stages: string[] = [];
  const read = readBundledWebStages((stage) => stages.push(stage));
  const emit = (stage: string) => read(Buffer.from(`[native-web-build] ${stage}\n`));
  const observe = observePreviewException(import.meta.dir, emit);
  const error = Object.assign(new Error('No such module "private-module"'), { code: 'ERR_RUNTIME_FAILURE' });
  error.stack = 'Error: private value\n    at start (/private/node_modules/miniflare/dist/src/index.js:123:45)';
  const request = Object.assign(new IncomingMessage(new Socket()), { method: 'GET', originalUrl: '/other' });
  const response = new ServerResponse(request);
  const forwarded: unknown[] = [];
  const next = (value: unknown) => forwarded.push(value);
  observe(error, request, response, next);
  expect(stages).toEqual([]);
  request.originalUrl = webReadinessPath;
  observe(error, request, response, next);
  observe(error, request, response, next);
  emit('preview-error no-entry ERR_RUNTIME_FAILURE missing-module /private/file.js:123:45');
  expect(stages).toEqual(['preview-error no-entry ERR_RUNTIME_FAILURE missing-module miniflare@123:45']);
  expect(forwarded).toEqual([error, error, error]);
});
