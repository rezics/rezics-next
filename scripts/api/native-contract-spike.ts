import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Generates disposable Elysia probes; never imports or changes the production app. */
export type SpikeRelease = 'pinned' | 'next';
export const spikeVersions = {
  pinned: { elysia: '2.0.0-beta.16', '@elysia/eden': '2.0.0-beta.5', '@elysia/openapi': '2.0.0-beta.4' },
  next: { elysia: '2.0.0-beta.32', '@elysia/eden': '2.0.0-beta.6', '@elysia/openapi': '2.0.0-beta.6' },
} as const;

const compilerOptions = {
  target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  noEmit: true, types: ['bun'], allowImportingTsExtensions: true, skipLibCheck: true,
};

function save(root: string, name: string, value: string) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

const declarations = `import { HTTPError, t } from 'elysia';
export class OutOfStock extends HTTPError.id('OUT_OF_STOCK', 409) {
  DETAIL
}
export class Locked extends HTTPError.id('LOCKED', 409) {}
export class Missing extends HTTPError.id('MISSING', 404) {}
export class ForeignError extends Error { readonly status = 410; }
export const stock = { type: 'https://example.test/problems/OUT_OF_STOCK', title: 'Conflict',
  status: 409, code: 'OUT_OF_STOCK', detail: 'No stock' } as const;
export function problemSchema<const S extends number, const C extends string>(status: S, code: C) {
  return t.Object({ type: t.String(), title: t.String(), status: t.Literal(status),
    code: t.Literal(code), detail: t.Optional(t.String()) }, { additionalProperties: false });
}
export const models = {
  Stock: problemSchema(409, 'OUT_OF_STOCK'), Locked: problemSchema(409, 'LOCKED'),
  Missing: problemSchema(404, 'MISSING'), Unauthorized: problemSchema(401, 'UNAUTHORIZED'),
  Limited: problemSchema(429, 'RATE_LIMITED'), Unavailable: problemSchema(503, 'UNAVAILABLE'),
};
export const success = t.Object({ id: t.String() });
export const responses = { 200: success, 401: models.Unauthorized,
  404: models.Missing, 409: t.Union([models.Stock, models.Locked]), 429: models.Limited };
export const readOperation = { method: 'get', path: '/read/:id', options: {
  params: t.Object({ id: t.String() }), response: responses,
  auth: 'public', exposure: 'public', rateLimit: 'read', detail: { operationId: 'spikeRead' },
} } as const;
export const commandOperation = { method: 'post', path: '/command/:id', options: {
  params: t.Object({ id: t.String() }), body: t.Object({ name: t.String() }), response: responses,
  auth: 'required', exposure: 'platform:test', rateLimit: 'write', detail: { operationId: 'spikeCommand' },
} } as const;
`;

const policies = `import { Elysia, problem } from 'elysia';
export function policies() {
  const counts = new Map<string, number>();
  return new Elysia({ name: 'spike-policies' }).macro({
    auth: (mode: 'public' | 'required') => ({
      derive({ headers }) {
        if (mode === 'required' && headers.authorization !== 'Bearer test')
          return problem(401, { code: 'UNAUTHORIZED' as const });
        return { principal: { id: mode === 'public' ? 'visitor' : 'member' } };
      },
      detail: { security: mode === 'required' ? [{ bearerAuth: [] }] : [] },
      meta: { auth: mode },
    }),
    exposure: (value: 'public' | 'platform:test') => ({
      beforeHandle({ headers }) {
        if (value !== 'public' && headers['x-platform'] !== 'open')
          return problem(404, { code: 'MISSING' as const });
      },
      detail: { 'x-exposure': value }, meta: { exposure: value },
    }),
    rateLimit: (family: 'read' | 'write') => ({
      beforeHandle({ headers }) {
        const key = family + ':' + (headers['x-client'] ?? 'default');
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > 2) return problem(429, { code: 'RATE_LIMITED' as const });
      },
      detail: { 'x-rate-limit-family': family }, meta: { rateLimit: family },
    }),
  });
}
`;

const handlers = `import type { Context, UnwrapRoute } from 'elysia';
import { readOperation, commandOperation } from './contracts.ts';
type Read = Context<UnwrapRoute<typeof readOperation.options>>;
type Command = Context<UnwrapRoute<typeof commandOperation.options>>;
export function read({ params }: Pick<Read, 'params'>) { return { id: params.id }; }
export function command({ params, body }: Pick<Command, 'params' | 'body'>,
  principal: { id: string }) { return { id: params.id + body.name + principal.id }; }
`;

const app = `import { Elysia, HTTPError, problem, status, t } from 'elysia';
import { openapi } from '@elysia/openapi';
import { OutOfStock, Locked, ForeignError, models, success, responses, stock, problemSchema,
  readOperation, commandOperation } from './contracts.ts';
import { read, command } from './handlers.ts';
import { policies } from './policies.ts';
HTTPError.typeBase = 'https://example.test/problems';
export const application = new Elysia().use(openapi({ path: '/openapi', documentation: {
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
} })).use(policies()).model(models)
  .get('/returned', () => new OutOfStock())
  .get('/thrown', () => { if (Date.now() > 0) throw new OutOfStock(); return { id: 'ok' }; })
  .get('/status', () => status(409, stock))
  .get('/problem', () => problem(stock))
  .get('/schema', { response: responses }, () => problem(stock))
  .get('/one-declaration', { response: { 200: success,
    [stock.status]: problemSchema(stock.status, stock.code) } }, () => problem(stock))
  .get('/failures/:kind', { response: responses }, ({ params }) => {
    if (params.kind === 'locked') return problem(409, { code: 'LOCKED' as const });
    if (params.kind === 'missing') return problem(404, { code: 'MISSING' as const });
    return problem(stock);
  })
  .get('/model', { response: { 409: 'Stock' } }, () => problem(stock))
  .get('/raw', { response: responses }, () => Response.json({ leaked: 'raw bypass' }, { status: 409 }))
  .get('/undeclared-success', { response: { 409: models.Stock } }, () => ({ id: 7 }))
  .get('/wrong-schema', { response: { 200: success } }, () => ({ id: 7 } as never))
  CLASS_SCHEMA
  .get('/foreign', () => new ForeignError('foreign message'))
  .HOOK(ForeignError, ({ error }) => problem(410, { code: 'GONE' as const, detail: error.message }))
  .get('/mapped-returned', () => new ForeignError('mapped'))
  .get('/mapped-thrown', () => { if (Date.now() > 0) throw new ForeignError('mapped'); return { id: 'ok' }; })
  .get('/accepted', { response: { 200: success,
    202: t.Object({ state: t.Literal('pending'), operation: t.String() }) } },
    ({ status }) => status(202, { state: 'pending', operation: 'op' }))
  .guard({ response: { 503: models.Unavailable } }, (group) =>
    group.get('/guarded', () => problem(503, { code: 'UNAVAILABLE' as const })))
  .use(app => app[readOperation.method](readOperation.path, readOperation.options, read))
  .use(app => app[commandOperation.method](commandOperation.path, commandOperation.options,
    ({ params, body, principal }) => command({ params, body }, principal)))
  .get('/overlay', { response: { 200: success, 409: models.Stock }, detail: { responses: {
    409: { description: 'authored conflict', headers: { 'Retry-After': { schema: { type: 'string' } } },
      content: { 'application/problem+json': { schema: models.Stock } } },
    418: { description: 'authored only' },
  } } }, () => ({ id: 'ok' }));
export const genericHook = new Elysia().HOOK(() => problem(503, { code: 'UNAVAILABLE' as const }))
  .get('/hook', () => ({ id: 'ok' }));
export const unhandled = new Elysia().get('/foreign', () => new ForeignError('foreign message'))
  .get('/unknown', () => { throw new Error('secret implementation detail'); });
`;

const positive = `import { treaty } from '@elysia/eden';
import { application, genericHook } from './app.ts';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Routes = typeof application['~Routes'];
export type Returned = Assert<Equal<Routes['returned']['get']['response'][409]['code'], 'OUT_OF_STOCK'>>;
export type TypeBaseSlug = Assert<Equal<Routes['returned']['get']['response'][409]['type'], 'OUT_OF_STOCK'>>;
export type ThrownMissing = Assert<Equal<Extract<409, keyof Routes['thrown']['get']['response']>, never>>;
export type Status = Assert<Equal<Routes['status']['get']['response'][409]['code'], 'OUT_OF_STOCK'>>;
export type Model = Assert<Equal<Routes['model']['get']['response'][409]['code'], 'OUT_OF_STOCK'>>;
export type OneDeclaration = Assert<Equal<Routes['one-declaration']['get']['response'][409]['code'], 'OUT_OF_STOCK'>>;
export type BuiltinValidation = Assert<Equal<Routes['command'][':id']['post']['response'][422]['status'], 422>>;
export type Mapped = Assert<Equal<Routes['mapped-returned']['get']['response'][410]['code'], 'GONE'>>;
export type EarlierMapped = Assert<Equal<Routes['foreign']['get']['response'][410]['code'], 'GONE'>>;
export type MappedThrownMissing = Assert<Equal<Extract<410, keyof Routes['mapped-thrown']['get']['response']>, never>>;
export type Hook = Assert<Equal<typeof genericHook['~Routes']['hook']['get']['response'][503]['code'], 'UNAVAILABLE'>>;
export type AuthMeta = Assert<Equal<Routes['command'][':id']['post']['meta']['auth'], 'public' | 'required'>>;
const client = treaty<typeof application>('http://spike.test');
export async function clientProof() {
  const response = await client.schema.get();
  if (response.error?.status === 409) {
    const code: 'OUT_OF_STOCK' | 'LOCKED' = response.error.value.code;
    if (response.error.value.code === 'OUT_OF_STOCK') {
      const narrowed: 'OUT_OF_STOCK' = response.error.value.code;
      return narrowed;
    }
    return code;
  }
  const returned = await client.returned.get();
  if (returned.error?.status === 409) {
    const code: 'OUT_OF_STOCK' = returned.error.value.code;
    return code;
  }
  const accepted = await client.accepted.get();
  if (accepted.data && 'state' in accepted.data) {
    const pending: 'pending' = accepted.data.state;
    return pending;
  }
}
`;

const runtime = `import { application, genericHook, unhandled } from './app.ts';
async function request(path: string, options?: RequestInit) {
  const response = await application.handle(new Request('http://spike.test' + path, options));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* foreign errors can be text */ }
  return { status: response.status, contentType: response.headers.get('content-type'), body };
}
const outputs: Record<string, unknown> = {};
for (const path of ['returned', 'thrown', 'status', 'problem', 'schema', 'model', 'raw',
  'wrong-schema', 'class-schema', 'class-mismatch', 'undeclared-success', 'one-declaration', 'foreign', 'mapped-returned', 'mapped-thrown', 'accepted', 'guarded'])
  outputs[path] = await request('/' + path);
outputs.read = await request('/read/abc');
outputs.failures = [await request('/failures/stock'), await request('/failures/locked'), await request('/failures/missing')];
outputs.unknown = { status: (await unhandled.handle('/unknown')).status,
  body: await (await unhandled.handle('/unknown')).json() };
outputs.unhandledForeign = { status: (await unhandled.handle('/foreign')).status,
  body: await (await unhandled.handle('/foreign')).text() };
outputs.genericHook = { status: (await genericHook.handle('/hook')).status };
outputs.readLimited = [await request('/read/abc'), await request('/read/abc')];
function post(headers: Record<string, string>) {
  return request('/command/abc', { method: 'POST', body: JSON.stringify({ name: 'name' }),
    headers: { 'content-type': 'application/json', ...headers } });
}
outputs.unauthorized = await post({});
outputs.hidden = await post({ authorization: 'Bearer test' });
outputs.command = await post({ authorization: 'Bearer test', 'x-platform': 'open' });
outputs.commandLimited = [await post({ authorization: 'Bearer test', 'x-platform': 'open' }),
  await post({ authorization: 'Bearer test', 'x-platform': 'open' })];
outputs.invalidInput = await request('/command/abc', { method: 'POST', body: '{}',
  headers: { authorization: 'Bearer test', 'x-platform': 'open', 'content-type': 'application/json' } });
outputs.openapi = (await request('/openapi/json')).body;
console.log(JSON.stringify(outputs));
`;

const negatives: Record<string, string> = {
  success: "new Elysia().get('/bad', { response: { 200: success } }, () => ({ id: 7 }));",
  code: "new Elysia().get('/bad', { response: responses }, ({ status }) => status(409, { ...stock, code: 'WRONG' }));",
  status: "new Elysia().get('/bad', { response: responses }, ({ status }) => status(418, stock));",
  input: "new Elysia().use(policies()).post('/bad', commandOperation.options, ({ body }) => ({ id: body.missing }));",
  binding: "const wrong = (_input: { params: { id: string } }) => ({ id: 7 }); new Elysia().use(policies())[readOperation.method](readOperation.path, readOperation.options, wrong);",
  classSchema: "import { OutOfStock } from '../contracts.ts'; new Elysia().get('/bad', { response: { 200: success, 409: models.Stock } }, () => new OutOfStock());",
  classMismatch: "import { Locked } from '../contracts.ts'; new Elysia().get('/bad', { response: { 200: success, 409: models.Stock } }, () => new Locked());",
  classModel: "import { OutOfStock } from '../contracts.ts'; new Elysia().model('Stock', OutOfStock);",
  onError: "new Elysia().onError(() => 'error');",
  error: "new Elysia().error(() => 'error');",
  detailProperty: "class DetailProperty extends HTTPError.id('DETAIL', 409) { readonly detail = 'detail'; }",
  detailMethod: "class DetailMethod extends HTTPError.id('DETAIL', 409) { detail() { return 'detail'; } }",
  missingResponse: "new Elysia().get('/bad', { response: { 409: models.Stock } }, () => ({ id: 7 }));",
};

export function prepareSpike(directory: string, release: SpikeRelease) {
  const root = resolve(directory);
  const dependencies = { ...spikeVersions[release], typebox: '1.3.34',
    'exact-mirror': '1.2.6', 'openapi-types': '12.1.3', '@scalar/types': '0.18.3' };
  save(root, 'package.json', JSON.stringify({ name: 'native-contract-spike', private: true,
    type: 'module', packageManager: 'yarn@4.18.0', dependencies }, null, 2));
  if (!existsSync(join(root, 'yarn.lock'))) save(root, 'yarn.lock', '');
  save(root, '.yarnrc.yml', 'nodeLinker: node-modules\nenableGlobalCache: false\ncacheFolder: .yarn/cache\n' +
    'npmPreapprovedPackages:\n' + Object.entries(dependencies).map(([name, version]) => `  - '${name}@${version}'`).join('\n') + '\n');
  const hook = release === 'next' ? 'onError' : 'error';
  const sources = {
    'contracts.ts': declarations.replace('DETAIL', release === 'next'
      ? "readonly detail = 'No stock';" : "detail() { return 'No stock' as const; }"),
    'policies.ts': policies, 'handlers.ts': handlers,
    'app.ts': app.replaceAll('HOOK', hook).replace('CLASS_SCHEMA',
      release === 'pinned' ? '' : ".get('/class-schema', { response: { 200: success, 409: models.Stock } }, () => new OutOfStock())\n  .get('/class-mismatch', { response: { 200: success, 409: models.Stock } }, () => new Locked())"),
    'positive.ts': release === 'pinned' ? positive : positive.replace(
      "Routes['foreign']['get']['response'][410]['code'], 'GONE'",
      "Routes['foreign']['get']['response'][410], string"),
    'runtime.ts': runtime,
  };
  for (const [name, source] of Object.entries(sources)) save(root, name, source);
  save(root, 'tsconfig.json', JSON.stringify({ compilerOptions, files: ['positive.ts'] }, null, 2));
  for (const [name, source] of Object.entries(negatives)) {
    save(root, `negative/${name}.ts`, "import { Elysia, HTTPError } from 'elysia';\nimport { policies } from '../policies.ts';\nimport { success, responses, stock, commandOperation, readOperation, models } from '../contracts.ts';\n" + source + '\n');
    save(root, `negative/${name}.json`, JSON.stringify({ compilerOptions, files: [`${name}.ts`] }));
  }
  save(root, 'release.json', JSON.stringify({ release, versions: spikeVersions[release] }));
  return root;
}

export type SpikeMode = 'current' | 'native-inline' | 'native-separated';
export function benchmarkSources(count: number, mode: SpikeMode): Record<string, string> {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('route count must be 1..100');
  const typed = mode !== 'current';
  const separated = mode === 'native-separated';
  const contract = `import { t } from 'elysia';
const failure = <const S extends number, const C extends string>(status: S, code: C) =>
  t.Object({ type: t.String(), title: t.String(), status: t.Literal(status),
    code: ${typed ? 't.Literal(code)' : 't.String()'} });
export const options = { params: t.Object({ id: t.String() }), body: t.Object({ name: t.String() }),
  response: { 200: t.Object({ id: t.String() }),
    401: failure(401, 'UNAUTHORIZED'), 404: failure(404, 'MISSING'),
    409: t.Union([failure(409, 'OUT_OF_STOCK'), failure(409, 'LOCKED')]),
    429: failure(429, 'RATE_LIMITED') },
  auth: 'required', exposure: 'platform:test', rateLimit: 'write' } as const;
`;
  const sources: Record<string, string> = { 'policies.ts': policies };
  let source = `import { Elysia, problem } from 'elysia';\nimport { policies } from './policies.ts';\n`;
  if (separated) {
    sources['contracts.ts'] = contract;
    sources['handlers.ts'] = `import type { Context, UnwrapRoute } from 'elysia';
import { options } from './contracts.ts';
export function handle({ params, body }: Pick<Context<UnwrapRoute<typeof options>>, 'params' | 'body'>) {
  if (params.id === 'missing') return problemMissing();
  return { id: params.id + body.name };
}
import { problem } from 'elysia';
function problemMissing() { return problem(404, { code: 'MISSING' as const }); }
`;
    source += "import { options } from './contracts.ts';\nimport { handle } from './handlers.ts';\n";
  } else source += contract.replace("import { t } from 'elysia';", "import { t } from 'elysia';");
  source += 'export const application = new Elysia().use(policies())\n';
  for (let index = 0; index < count; index++) {
    const handler = separated ? 'handle' : `({ params, body }) => {
      if (params.id === 'missing') return ${typed ? "problem(404, { code: 'MISSING' as const })"
        : "Response.json({ type: 'about:blank', title: 'Not Found', status: 404, code: 'MISSING' }, { status: 404 })"};
      return { id: params.id + body.name };
    }`;
    source += `  .post('/route${index}/:id', options, ${handler})\n`;
  }
  source += ';\n';
  sources['app.ts'] = source;
  sources['consumer.ts'] = `import { treaty } from '@elysia/eden';
import type { application } from './app.ts';
const client = treaty<typeof application>('http://spike.test');
export async function exercise() {
${Array.from({ length: count }, (_, index) => `  const result${index} = await client.route${index}({ id: 'x' }).post({ name: 'x' });
  if (result${index}.error?.status === 409) { const code: ${typed ? "'OUT_OF_STOCK' | 'LOCKED'" : 'string'} = result${index}.error.value.code; console.log(code); }`).join('\n')}
}
`;
  return sources;
}

export interface TypecheckResult {
  exitCode: number; wallMs: number; instantiations: number | null; checkSeconds: number | null;
  diagnostics: string;
}
export async function typecheck(project: string): Promise<TypecheckResult> {
  const start = performance.now();
  const child = Bun.spawn(['bun', resolve('node_modules/typescript/bin/tsc'),
    '--project', project, '--extendedDiagnostics', '--pretty', 'false'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const output = stdout + stderr;
  return { exitCode, wallMs: Math.round(performance.now() - start),
    instantiations: numberField(output, 'Instantiations'), checkSeconds: numberField(output, 'Check time'),
    diagnostics: output.split('\n').filter(line => /error TS/.test(line)).join('\n') };
}

export async function probeSpike(directory: string) {
  const root = resolve(directory);
  verifyVersions(root);
  const positiveResult = await typecheck(join(root, 'tsconfig.json'));
  if (positiveResult.exitCode) throw new Error(positiveResult.diagnostics);
  const diagnostics: Record<string, TypecheckResult> = {};
  for (const name of Object.keys(negatives)) diagnostics[name] = await typecheck(join(root, `negative/${name}.json`));
  const child = Bun.spawn(['bun', join(root, 'runtime.ts')], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode) throw new Error(stderr);
  const runtimeResult: Record<string, unknown> = JSON.parse(stdout);
  const result = { positive: positiveResult, diagnostics, runtime: runtimeResult };
  save(root, 'probe.json', JSON.stringify(result, null, 2));
  return result;
}
function numberField(output: string, label: string) {
  const match = output.match(new RegExp('^' + label + ':\\s+([\\d.]+)', 'm'));
  return match ? Number(match[1]) : null;
}

export async function measureSpike(directory: string, repeats = 3, counts = [1, 20, 100]) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1..10');
  const root = resolve(directory);
  verifyVersions(root);
  const metadata = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')) as { release: SpikeRelease };
  const results = [];
  for (const count of counts) for (const mode of ['current', 'native-inline', 'native-separated'] as const) {
    const target = join(root, `bench/${mode}/${count}`);
    for (const [name, source] of Object.entries(benchmarkSources(count, mode))) save(target, name, source);
    for (const [kind, files] of [['server', ['app.ts']], ['eden', ['consumer.ts']]] as const) {
      const project = join(target, `${kind}.json`);
      save(target, `${kind}.json`, JSON.stringify({ compilerOptions, files }));
      for (let repeat = 0; repeat < repeats; repeat++) {
        const result = await typecheck(project);
        results.push({ release: metadata.release, count, mode, kind, repeat, ...result });
      }
    }
  }
  save(root, 'measurements.json', JSON.stringify(results, null, 2));
  return results;
}

function verifyVersions(root: string) {
  const { versions } = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')) as {
    versions: Record<string, string>;
  };
  for (const [name, expected] of Object.entries(versions)) {
    const entry = Bun.resolveSync(name, root);
    const { version } = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8')) as { version: string };
    if (version !== expected) throw new Error(`${name}: wanted ${expected}, resolved ${version}; install scratch dependencies`);
  }
}

function summarizeMeasurements(samples: Awaited<ReturnType<typeof measureSpike>>) {
  const groups = new Map<string, typeof samples>();
  for (const sample of samples) {
    const key = `${sample.count}/${sample.mode}/${sample.kind}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key,
    wallMs: median(group.map(sample => sample.wallMs)),
    checkSeconds: median(group.map(sample => sample.checkSeconds ?? 0)),
    instantiations: group[0]!.instantiations,
    failed: group.filter(sample => sample.exitCode !== 0).length,
  }));
}
function median(values: number[]) { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!; }

if (import.meta.main) {
  const [action, directory, argument] = Bun.argv.slice(2);
  if (!directory) throw new Error('prepare <.temp/directory> <pinned|next> | probe <directory> | measure <directory> [repeats] | compare <directory> [repeats] | types <project>');
  if (action === 'prepare') {
    if (argument !== 'pinned' && argument !== 'next') throw new Error('release must be pinned or next');
    console.log(prepareSpike(directory, argument));
  } else if (action === 'probe') {
    const result = await probeSpike(directory);
    console.log(JSON.stringify({ positive: result.positive, diagnostics: result.diagnostics,
      artifact: join(directory, 'probe.json') }));
  } else if (action === 'measure') {
    const result = await measureSpike(directory, Number(argument ?? 3));
    console.log(JSON.stringify({ samples: result.length, summary: summarizeMeasurements(result),
      artifact: join(directory, 'measurements.json') }));
  } else if (action === 'compare') {
    for (const release of ['pinned', 'next']) {
      const result = await measureSpike(join(directory, release), Number(argument ?? 3));
      console.log(JSON.stringify({ release, samples: result.length, summary: summarizeMeasurements(result) }));
    }
  } else if (action === 'types') {
    const result = await typecheck(resolve(directory));
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  }
  else throw new Error('unknown spike action');
}
