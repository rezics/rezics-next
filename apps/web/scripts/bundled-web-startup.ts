import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';

export const webReadinessPath = '/en/subjects/00000000-0000-4000-8000-000000000000';

const stages = [
  'prepare-messages',
  'prepare-build',
  'build',
  'graph',
  'graph-failed',
  'render',
  'render-failed',
  'generate-bundle',
  'wrote-bundle',
  'build-failed',
  'preview',
  'configure-preview',
  'listen',
] as const;
type Stage = (typeof stages)[number];
const prefix = '[native-web-build] ';

const errorCodes = ['MISSING_EXPORT', 'UNRESOLVED_IMPORT', 'PARSE_ERROR', 'PLUGIN_ERROR', 'other'];
const stageLine = new RegExp(
  `^(?:${stages.join('|')})(?: (?:client|ssr))?(?: count=\\d{1,7} code=(?:${errorCodes.join('|')}))?$`,
);

const previewCodes = [
  'ERR_RUNTIME_FAILURE',
  'ERR_VALIDATION',
  'ERR_MODULE_PARSE',
  'ERR_MODULE_RULE',
  'ERR_MODULE_NOT_FOUND',
  'ERR_MODULE_DYNAMIC_SPEC',
  'ERR_ADDRESS_IN_USE',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_INVALID_CHAR',
  'ENOENT',
  'EACCES',
  'ECONNREFUSED',
  'ENOTFOUND',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'Error',
  'other',
];
const previewReasons = {
  'missing-module': /no such module|cannot find (?:module|package)/i,
  'missing-export': /does not provide an export named/i,
  'global-io': /disallowed operation called within global scope/i,
  'uninitialized-binding': /before initialization/i,
  'undefined-global': /is not defined/i,
  'worker-exception': /uncaught (?:exception|\w*error)/i,
  'runtime-start': /workers runtime failed to start/i,
  'fetch-failed': /fetch failed/i,
};
const previewFrames = {
  miniflare: /\/miniflare\/dist\/src\/index\.js/,
  adapter: /\/@cloudflare\/vite-plugin\/dist\/index\.mjs/,
  undici: /(?:\/undici\/|node:internal\/deps\/undici\/)/,
};
const previewErrorLine = new RegExp(
  `^preview-error (?:index\\.m?js|other-entry|no-entry) (?:${previewCodes.join('|')}) (?:${Object.keys(previewReasons).join('|')}|other) (?:${Object.keys(previewFrames).join('|')}|worker-entry|worker-chunk(?:-[\\w$-]{8})?|other)(?:@\\d{1,8}:\\d{1,8})?$`,
);

/** Miniflare can carry workerd startup stderr in the message or revive a thrown Worker's stack. */
function previewException(error: unknown, root: string): string {
  const directory = join(root, '.cloudflare/output/v0/workers/default');
  const bundle = join(directory, 'bundle');
  let main: string | undefined;
  try {
    const { manifest } = JSON.parse(readFileSync(join(directory, 'worker.config.json'), 'utf8'));
    if (
      typeof manifest?.mainModule === 'string' &&
      /^(?:assets\/)?[\w.-]+\.m?js$/.test(manifest.mainModule) &&
      existsSync(join(bundle, manifest.mainModule))
    ) {
      main = manifest.mainModule;
    }
  } catch {
    // Still report the dispatch exception when the output is unavailable.
  }
  const entry = main === 'index.js' || main === 'index.mjs' ? main : main ? 'other-entry' : 'no-entry';
  if (!(error instanceof Error)) return `preview-error ${entry} other other other`;
  const { code: outerCode, cause } = error as NodeJS.ErrnoException;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause && cause.code;
  const code =
    [outerCode, causeCode, error.name].find(
      (value): value is string => typeof value === 'string' && previewCodes.includes(value),
    ) ?? 'other';
  const message = typeof error.message === 'string' ? error.message.slice(0, 8192) : '';
  const reason = Object.entries(previewReasons).find(([, pattern]) => pattern.test(message))?.[0];
  const detail = `preview-error ${entry} ${code} ${reason ?? 'other'}`;
  const stack = typeof error.stack === 'string' ? error.stack.slice(0, 16384) : '';
  for (const line of stack.split('\n')) {
    if (!/^\s*at\s/.test(line)) continue;
    const position = /(?:\(|^\s*at (?:async )?)([^()\s]+):(\d{1,8}):(\d{1,8})\)?\s*$/.exec(line);
    if (!position) continue;
    const location = position[1]!.replace(/^file:\/\//, '');
    const frame = Object.entries(previewFrames).find(([, pattern]) => pattern.test(location));
    let owner = frame?.[0];
    if (!owner && main) {
      const file = location.startsWith(`${bundle}/`) ? location.slice(bundle.length + 1) : location;
      if (file === main) owner = 'worker-entry';
      else if (/^assets\/[\w.-]+\.m?js$/.test(file) && existsSync(join(bundle, file))) {
        const hash = /-([\w$-]{8})\.m?js$/.exec(file)?.[1];
        owner = hash ? `worker-chunk-${hash}` : 'worker-chunk';
      }
    }
    if (owner) return `${detail} ${owner}@${position[2]}:${position[3]}`;
  }
  return `${detail} other`;
}

export function observePreviewException(root: string, report: (stage: string) => void): Connect.ErrorHandleFunction {
  let reported = false;
  return (error: unknown, request, _response, next) => {
    if (!reported && request.method === 'GET' && request.originalUrl === webReadinessPath) {
      reported = true;
      report(previewException(error, root));
    }
    next(error);
  };
}

function buildFailure(error: unknown): string {
  const errors =
    error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors) ? error.errors : [error];
  const first: unknown = errors[0];
  const code = first && typeof first === 'object' && ('kind' in first ? first.kind : 'code' in first && first.code);
  return ` count=${Math.min(errors.length, 9_999_999)} code=${typeof code === 'string' && errorCodes.includes(code) ? code : 'other'}`;
}

export function bundledWebStage(stage: Stage, environment?: string, error?: unknown): void {
  const target = environment === 'ssr' || environment === 'client' ? ` ${environment}` : '';
  process.stderr.write(`${prefix}${stage}${target}${error ? buildFailure(error) : ''}\n`);
}

/** Only forward complete protocol lines. Compiler diagnostics can contain source or Worker bindings. */
export function readBundledWebStages(report: (stage: string) => void) {
  let partial = '';
  return (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const [index, line] of lines.entries()) {
      partial = (partial + line).slice(0, 160);
      if (index === lines.length - 1) break;
      if (partial.length < 160 && partial.startsWith(prefix)) {
        const value = partial.slice(prefix.length);
        if (stageLine.test(value) || previewErrorLine.test(value)) report(value);
      }
      partial = '';
    }
  };
}

export function bundledWebStartupPlugin(): Plugin {
  return {
    name: 'native-bundled-web-startup',
    enforce: 'pre',
    buildStart() {
      bundledWebStage('graph', this.environment.name);
    },
    buildEnd(error) {
      if (error) bundledWebStage('graph-failed', this.environment.name, error);
    },
    renderStart() {
      bundledWebStage('render', this.environment.name);
    },
    renderError(error) {
      bundledWebStage('render-failed', this.environment.name, error);
    },
    generateBundle() {
      bundledWebStage('generate-bundle', this.environment.name);
    },
    writeBundle() {
      bundledWebStage('wrote-bundle', this.environment.name);
    },
    configurePreviewServer(server) {
      bundledWebStage('configure-preview');
      server.httpServer.once('listening', () => bundledWebStage('listen'));
      // Install after Cloudflare's dispatch middleware, before Connect formats its production 500.
      return () => {
        server.middlewares.use(
          observePreviewException(server.config.root, (stage) => process.stderr.write(`${prefix}${stage}\n`)),
        );
      };
    },
  };
}
