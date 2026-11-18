import type { Plugin } from 'vite';

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
      partial = (partial + line).slice(0, 80);
      if (index === lines.length - 1) break;
      if (partial.length < 80 && partial.startsWith(prefix)) {
        const value = partial.slice(prefix.length);
        if (stageLine.test(value)) report(value);
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
    },
  };
}
