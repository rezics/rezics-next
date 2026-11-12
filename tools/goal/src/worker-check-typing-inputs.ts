/** Compiler evidence is narrower than budget/source custody. Unknown runners retain the complete source tree. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import {
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type TypingInput = { path: string; digest: string };
export type TypingInputs = {
  version: 1;
  profile: 'configured-typescript' | 'conservative';
  source: TypingInput[];
  prepared: TypingInput[];
  excludedDocuments: string[];
  runtime: string;
};
export type TypingInputReceipt = {
  version: 1;
  physicalRunId: string;
  command: string[];
  compilerCommand: string[];
  started: TypingInputs;
  completed: TypingInputs;
  sourceStable: boolean;
  exitCode: number;
  outputs?: ['kernel-client-v1'];
};
export const typingInputsReceiptPath = (physical: string): string => `.temp/goal/checks/typing-inputs/${physical}.json`;
const GENERATED_CLIENT = 'packages/client/src/kernel/';
// These are outputs of the owning generation commands, before their compiler programs run.
const producedDuringPreparation = (file: string): boolean =>
  /^apps\/(web|auth)\/src\/(?:paraglide\/|routeTree\.gen\.ts$)/.test(file);
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function gitFiles(root: string): string[] {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`typing inputs: source inventory unavailable: ${run.stderr.trim()}`);
  return [...new Set(run.stdout.split('\0').filter(Boolean))].sort();
}

function localPath(root: string, file: string): string | undefined {
  const inside = relative(root, resolve(file)).replaceAll('\\', '/');
  return inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('../') ? inside : undefined;
}

function input(root: string, file: string): TypingInput {
  try {
    const info = lstatSync(join(root, file));
    return {
      path: file,
      digest: info.isSymbolicLink()
        ? hash(
            Buffer.concat([
              Buffer.from(`link\0${readlinkSync(join(root, file))}\0`),
              statSync(join(root, file)).isFile() ? readFileSync(join(root, file)) : Buffer.alloc(0),
            ]),
          )
        : info.isFile()
          ? hash(readFileSync(join(root, file)))
          : hash(`mode\0${info.mode}`),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path: file, digest: 'missing' };
  }
}

/** The installed producer/consumer owners, in fail-fast order; arbitrary shell/custom compilers stay conservative. */
export function kernelClientTypingPipeline(root: string, argv: readonly string[]): boolean {
  if (argv.length !== 3 || !['sh', 'bash'].includes(argv[0]!) || argv[1] !== '-c') return false;
  const steps = argv[2]!.trim().split(/\s*&&\s*/);
  if (
    steps.length !== 2 ||
    steps[0]!.trim().replace(/\s+/g, ' ') !== 'bun run --cwd services/kernel typecheck --emit-client' ||
    steps[1]!.trim().replace(/\s+/g, ' ') !== 'bun run --cwd packages/client typecheck'
  )
    return false;
  try {
    const manifest = (path: string) => JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
    return (
      manifest('services/kernel').scripts?.typecheck === 'bun scripts/typecheck.ts' &&
      manifest('packages/client').scripts?.typecheck === 'bun check --no-script -p tsconfig.json'
    );
  } catch {
    return false;
  }
}

const COMPILER_SCRIPTS = new Set([
  'bun check --no-script -p tsconfig.json',
  'bun scripts/typecheck.ts',
  'bun scripts/typecheck.ts --root',
  'bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json',
]);
const GENERATOR_SCRIPTS = new Set([
  'bun scripts/generate.ts',
  'node .storybook/generate-routes.ts',
  'vite build --config vite.config.ts --mode development --emptyOutDir false',
]);
type CompilerGraph = { workspaces: Set<string>; executables: Set<string> };

function directKernelOwnerCommand(argv: readonly string[]): boolean {
  return (
    argv.length === 2 &&
    (argv[0] === 'bun' || argv[0]?.endsWith('/bun') === true) &&
    argv[1] === 'services/kernel/scripts/typecheck.ts'
  );
}

/** Recognize only the owning manifest scripts and fail-fast sequences of their standard argv. */
function compilerGraph(root: string, argv: readonly string[], files: readonly string[]): CompilerGraph | undefined {
  const manifests = new Map(
    files
      .filter((file) => /^(apps|services|packages)\/[^/]+\/package.json$/.test(file))
      .map((file) => [
        dirname(file),
        JSON.parse(readFileSync(join(root, file), 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        },
      ]),
  );
  const selected = new Set<string>();
  let all = false;
  if (kernelClientTypingPipeline(root, argv)) {
    selected.add('services/kernel');
    selected.add('packages/client');
  } else if (directKernelOwnerCommand(argv)) {
    const kernel = manifests.get('services/kernel');
    if (
      kernel?.name !== '@rezics/kernel' ||
      kernel.scripts?.typecheck !== 'bun scripts/typecheck.ts' ||
      !files.includes('services/kernel/scripts/typecheck.ts')
    )
      return undefined;
    selected.add('services/kernel');
  } else {
    const shell = argv.length === 3 && ['sh', 'bash'].includes(argv[0]!) && argv[1] === '-c';
    const commands = shell
      ? argv[2]!
          .trim()
          .split(/\s*&&\s*/)
          .map((step) => step.trim().split(/\s+/))
      : [argv];
    for (const command of commands) {
      if (command[0] === 'bun' && command[1] === 'scripts/typecheck.ts' && (!shell || command.length === 2)) {
        // The root owner validates its own selection/config arguments before compilation.
        all = true;
      } else if (
        command.length === 5 &&
        command[0] === 'bun' &&
        command[1] === 'run' &&
        command[2] === '--cwd' &&
        command[4] === 'typecheck' &&
        manifests.has(command[3]!)
      ) {
        selected.add(command[3]!);
      } else return undefined;
    }
  }
  if (all) for (const workspace of manifests.keys()) selected.add(workspace);
  for (const workspace of selected) {
    const scripts = manifests.get(workspace)?.scripts;
    if (!scripts?.typecheck && !all) return undefined;
    if (scripts?.typecheck && !COMPILER_SCRIPTS.has(scripts.typecheck)) return undefined;
    if (scripts?.['typecheck:root'] && !COMPILER_SCRIPTS.has(scripts['typecheck:root'])) return undefined;
    for (const name of ['generate', 'generate:routes'])
      if (scripts?.[name] && !GENERATOR_SCRIPTS.has(scripts[name]!)) return undefined;
  }
  const workspaces = new Set(selected);
  const byName = new Map(
    [...manifests].filter(([, manifest]) => manifest.name).map(([workspace, manifest]) => [manifest.name!, workspace]),
  );
  for (const workspace of workspaces) {
    const manifest = manifests.get(workspace);
    for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })) {
      const dependency = byName.get(name);
      if (dependency) workspaces.add(dependency);
    }
  }
  const executables = new Set<string>();
  if (all) executables.add('scripts/typecheck.ts');
  for (const workspace of selected) {
    for (const name of ['typecheck', 'typecheck:root', 'generate', 'generate:routes']) {
      const script = manifests.get(workspace)?.scripts?.[name];
      for (const match of script?.matchAll(/(?:^|&&)\s*(?:bun|node)\s+([^\s]+\.[cm]?[jt]s)/g) ?? [])
        executables.add(`${workspace}/${match[1]}`);
    }
  }
  return { workspaces, executables };
}

/** Admission authority is limited to these installed owning compiler commands, never filename heuristics. */
export function isKnownTypingCompiler(root: string, command: readonly string[]): boolean {
  return compilerGraph(root, command, gitFiles(root)) !== undefined;
}

/** The direct installed Kernel entrypoint has the same configured graph as its manifest typecheck owner. */
export function isDirectKernelTypingCompiler(root: string, command: readonly string[]): boolean {
  return directKernelOwnerCommand(command) && isKnownTypingCompiler(root, command);
}

function misorderedWorkspaceTypecheckIntent(command: readonly string[]): boolean {
  return (
    command.length === 5 &&
    (command[0] === 'bun' || command[0]?.endsWith('/bun') === true) &&
    command[1] === '--cwd' &&
    command[3] === 'run' &&
    command[4] === 'typecheck'
  );
}

/** Resolve a recognized workspace intent to its installed script form during typing-only recovery. */
export function resolveTypingCompilerCommand(root: string, command: readonly string[]): string[] | undefined {
  const canonical = misorderedWorkspaceTypecheckIntent(command)
    ? [command[0]!, 'run', '--cwd', command[2]!, 'typecheck']
    : [...command];
  return isKnownTypingCompiler(root, canonical) ? canonical : undefined;
}

/** Config parsing uses TypeScript's own include/extends semantics, including ignored generated root files. */
function configuredInputs(
  root: string,
  files: readonly string[],
  graph: CompilerGraph,
): { paths: Set<string>; documents: Set<string> } {
  const require = createRequire(join(root, 'package.json'));
  const executable = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  const aliases: { pattern: string; targets: string[] }[] = [];
  const paths = new Set<string>();
  const documents = new Set<string>();
  const configs = files.filter(
    (file) =>
      file === 'tsconfig.json' ||
      (graph.workspaces.has(dirname(file)) && /^tsconfig(?:\.[^/]+)?\.json$/.test(file.split('/').at(-1)!)),
  );
  if (configs.length === 0) throw new Error('typing inputs: no owning compiler configurations');
  const visited = new Set<string>();
  const inspectConfig = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const value = Bun.JSONC.parse(readFileSync(file, 'utf8')) as {
      extends?: string | string[];
      contentMappers?: { package?: string; extensions?: string[] }[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    // The pinned compiler's --showConfig expands files but omits contentMappers. Validate their source declarations.
    if (value.contentMappers?.some((mapper) => mapper.package !== 'reylo' || !same(mapper.extensions, ['.sql'])))
      throw new Error('typing inputs: custom mapper');
    const inside = localPath(root, file);
    if (!inside) throw new Error('typing inputs: external compiler configuration');
    paths.add(inside);
    for (const [pattern, targets] of Object.entries(value.compilerOptions?.paths ?? {}))
      aliases.push({
        pattern,
        targets: targets.map((target) => resolve(dirname(file), value.compilerOptions?.baseUrl ?? '.', target)),
      });
    for (const parent of typeof value.extends === 'string' ? [value.extends] : (value.extends ?? [])) {
      const target = parent.startsWith('.') ? resolve(dirname(file), parent) : createRequire(file).resolve(parent);
      inspectConfig(existsSync(target) ? target : `${target}.json`);
    }
  };
  for (const config of configs) {
    inspectConfig(join(root, config));
    // Use the installed compiler's config expansion. Its synchronous JS API requires Node-only pipe internals;
    // --showConfig is read-only, needs no database and works under the repository's Bun runner.
    const run = spawnSync(executable, ['--showConfig', '-p', join(root, config)], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.status !== 0) throw new Error(`typing inputs: config unavailable: ${config}: ${run.stdout || run.stderr}`);
    const parsed = JSON.parse(run.stdout) as {
      files?: string[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {}))
      aliases.push({
        pattern,
        targets: targets.map((target) =>
          resolve(root, dirname(config), parsed.compilerOptions?.baseUrl ?? '.', target),
        ),
      });
    paths.add(config);
    for (const file of parsed.files ?? []) {
      const inside = localPath(root, resolve(root, dirname(config), file));
      if (inside && !inside.split('/').includes('node_modules')) paths.add(inside);
    }
  }
  const candidates = files.filter((file) => file.endsWith('.md'));
  // Imported non-TS assets and compiler/generator literals remain inputs, even when the compiler represents them
  // through a content mapper or a wildcard declaration. Unknown non-document inputs are never subtracted.
  const byName = new Map<string, string[]>();
  for (const document of candidates) {
    const name = document.split('/').at(-1)!;
    byName.set(name, [...(byName.get(name) ?? []), document]);
  }
  // Non-document files remain in source custody. Asset traversal follows the owning configured programs and
  // executed compiler/generator modules; unrelated test fixtures and documentation-tool globs are not compiler inputs.
  for (const executable of graph.executables) paths.add(executable);
  const imports = new Map<string, string[]>();
  for (const file of paths) {
    if (!existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?|require\s*\(|reference\s+path=)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      const targets = specifier.startsWith('.') ? [resolve(root, dirname(file), specifier)] : [];
      for (const alias of aliases) {
        const [prefix, suffix] = alias.pattern.split('*');
        const wildcard =
          suffix !== undefined && specifier.startsWith(prefix!) && specifier.endsWith(suffix)
            ? specifier.slice(prefix!.length, suffix ? -suffix.length : undefined)
            : undefined;
        if (alias.pattern === specifier || wildcard !== undefined)
          targets.push(...alias.targets.map((target) => target.replace('*', wildcard ?? '')));
      }
      for (const target of targets) {
        const resolved = [
          target,
          ...['.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'].map((ext) => target + ext),
          target.replace(/\.[cm]?js$/, '.ts'),
        ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        const inside = resolved && localPath(root, resolved);
        if (inside && !inside.split('/').includes('node_modules')) {
          paths.add(inside);
          imports.set(file, [...(imports.get(file) ?? []), inside]);
        }
      }
    }
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(?|require\s*\(|reference\s+path=|import\.meta\.glob\s*\()\s*['"`]([^'"`\r\n]*\.md)(?:\?[^'"`\r\n]*)?['"`]/g,
    )) {
      const literal = match[1]!;
      if (/[*?${}]/.test(literal)) {
        for (const document of candidates) documents.add(document);
      } else {
        for (const document of byName.get(literal.split('/').at(-1)!) ?? []) documents.add(document);
      }
    }
  }
  // Known owner scripts can read static generator assets without importing them as TypeScript modules.
  const executed = new Set(graph.executables);
  for (const file of executed) {
    for (const imported of imports.get(file) ?? []) executed.add(imported);
    if (!existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const call of source.matchAll(
      /(?:readFileSync|readFile|Bun\.file|readOutputTreeFile)\s*\(([^;\n]{0,1024})/g,
    )) {
      for (const match of call[1]!.matchAll(/['"`]([^'"`\r\n]+)['"`]/g)) {
        const literal = match[1]!;
        if (!literal.includes('.temp/') && !literal.endsWith('.md')) continue;
        for (const target of [resolve(root, dirname(file), literal), resolve(root, literal)]) {
          const inside = localPath(root, target);
          if (inside && existsSync(target) && statSync(target).isFile()) paths.add(inside);
        }
      }
    }
  }
  for (const file of paths) if (file.endsWith('.md')) documents.add(file);
  return { paths, documents };
}

/** Unknown/custom inputs retain full custody; known owners omit only unconsumed documents and operational artifacts. */
export function captureTypingInputs(root: string, compilerCommand: readonly string[]): TypingInputs {
  root = resolve(root);
  const files = gitFiles(root);
  let profile: TypingInputs['profile'] = 'conservative';
  let configured = { paths: new Set<string>(), documents: new Set<string>() };
  const graph = compilerGraph(root, compilerCommand, files);
  if (graph) {
    try {
      configured = configuredInputs(root, files, graph);
      profile = 'configured-typescript';
    } catch {
      // A fresh tree can lack generated configs before preparation. That cannot authorize an exclusion.
    }
  }
  const excludedDocuments =
    profile === 'configured-typescript'
      ? files.filter((file) => file.endsWith('.md') && !configured.paths.has(file) && !configured.documents.has(file))
      : [];
  const excluded = new Set(excludedDocuments);
  const pipeline = kernelClientTypingPipeline(root, compilerCommand);
  const sourceFiles = files.filter(
    (file) =>
      !excluded.has(file) &&
      !file.startsWith(GENERATED_CLIENT) &&
      !(
        profile === 'configured-typescript' &&
        file.startsWith('.temp/') &&
        !configured.paths.has(file) &&
        !configured.documents.has(file)
      ) &&
      !(
        (profile === 'configured-typescript' &&
          !configured.paths.has(file) &&
          ['.preparation-started', '.remote-check-supervisor', 'preparation-install.json'].includes(file)) ||
        (pipeline &&
          (file === '.temp/check-output-tree/kernel-client-v1.bin' ||
            file.startsWith('packages/client/src/.kernel-output-tree/')))
      ),
  );
  const preparedFiles = new Set([
    ...files.filter((file) => file.startsWith(GENERATED_CLIENT)),
    ...[...configured.paths].filter((file) => !files.includes(file)),
  ]);
  // Installed mapper/compiler identity is separate from source custody and lockfile identity.
  for (const manifest of files.filter((file) => /(^|\/)package.json$/.test(file))) {
    const value = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...value.dependencies, ...value.devDependencies })) {
      const dependency = join(dirname(manifest), 'node_modules', name, 'package.json').replaceAll('\\', '/');
      if (existsSync(join(root, dependency))) preparedFiles.add(dependency);
    }
  }
  return {
    version: 1,
    profile,
    source: sourceFiles.map((file) => input(root, file)),
    prepared: [...preparedFiles].sort().map((file) => input(root, file)),
    excludedDocuments,
    runtime: `${Bun.version}:${Bun.revision}:${process.platform}:${process.arch}`,
  };
}

function stableSource(started: TypingInputs, completed: TypingInputs, outputs: readonly string[] = []): boolean {
  // Preparation can make a config graph available. Compare every admitted source using the completed exclusion set;
  // a source added or changed during compilation still prevents a pass, including an imported former document.
  const excluded = new Set(completed.excludedDocuments);
  return (
    same(
      started.source.filter((entry) => !excluded.has(entry.path)),
      completed.source,
    ) &&
    same(
      started.prepared.filter(
        (entry) =>
          !producedDuringPreparation(entry.path) &&
          !(outputs.includes('kernel-client-v1') && entry.path.startsWith(GENERATED_CLIENT)),
      ),
      completed.prepared.filter(
        (entry) =>
          !producedDuringPreparation(entry.path) &&
          !(outputs.includes('kernel-client-v1') && entry.path.startsWith(GENERATED_CLIENT)),
      ),
    )
  );
}

/** Capture every admitted physical command, including workspace runners predating compiler receipt support. */
export function typingInputCommand(command: readonly string[]): string[] {
  // Carry the standalone capture implementation through argv for old frozen worktrees, compressed to fit custody.
  // Keep each transferred argument under remote custody's 4096-character bound.
  const payload = deflateSync(
    JSON.stringify({
      captureModuleSource: readFileSync(import.meta.path, 'utf8'),
      command,
    }),
  ).toString('base64');
  const payloadChunks = payload.match(/.{1,3000}/g) ?? [];
  return [
    'bun',
    '-e',
    `
const { inflateSync } = await import('node:zlib');
const payload = process.argv.slice(1).join('');
const { captureModuleSource, command } = JSON.parse(inflateSync(Buffer.from(payload, 'base64')).toString('utf8'));
let complete;
let readReceipt;
try {
  const captureModule = Buffer.from(captureModuleSource, 'utf8').toString('base64');
  const inputs = await import('data:text/typescript;base64,' + captureModule);
  readReceipt = inputs.readTypingInputReceipt;
  complete = inputs.beginTypingInputReceipt(process.cwd(), process.env, command);
} catch (error) { console.error('typing inputs unavailable before compilation: ' + error); }
const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
const code = await child.exited;
try {
  // An owning compiler can finish successfully before a later money/test command fails. Retain its exact verdict.
  const request = JSON.parse(Buffer.from(process.env.REZICS_TYPING_INPUTS_COMMAND ?? '', 'base64').toString());
  if (!readReceipt?.(process.cwd(), process.env.REZICS_TYPING_INPUTS_PHYSICAL, request)) complete?.(code);
} catch (error) { console.error('typing inputs unavailable after compilation: ' + error); }
process.exit(code);
`,
    '--',
    ...payloadChunks,
  ];
}

/** Invoked by the owning compiler, in the actual frozen/prepared checkout, not at controller settlement time. */
export function beginTypingInputReceipt(
  root: string,
  env: NodeJS.ProcessEnv,
  compilerCommand: string[],
): ((exitCode: number) => void) | undefined {
  const physical = env.REZICS_TYPING_INPUTS_PHYSICAL;
  const request = env.REZICS_TYPING_INPUTS_COMMAND;
  if (!physical || !request) return undefined;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(physical))
    throw new Error('typing inputs: malformed physical identity');
  const command: unknown = JSON.parse(Buffer.from(request, 'base64').toString('utf8'));
  if (!Array.isArray(command) || command.some((argument) => typeof argument !== 'string'))
    throw new Error('typing inputs: malformed invocation');
  const outputs: ['kernel-client-v1'] | undefined = kernelClientTypingPipeline(root, compilerCommand)
    ? ['kernel-client-v1']
    : undefined;
  const started = captureTypingInputs(root, compilerCommand);
  return (exitCode) => {
    const completed = captureTypingInputs(root, compilerCommand);
    const receipt: TypingInputReceipt = {
      version: 1,
      physicalRunId: physical,
      command,
      compilerCommand,
      started,
      completed,
      sourceStable: stableSource(started, completed, outputs),
      ...(outputs ? { outputs } : {}),
      exitCode,
    };
    const file = join(root, typingInputsReceiptPath(physical));
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt));
    renameSync(temporary, file);
  };
}

/** The returned file is untrusted transport input; failure leaves explicit unavailable evidence, never a pass. */
export function readTypingInputReceipt(
  root: string,
  physical: string,
  command: readonly string[],
): TypingInputReceipt | undefined {
  const file = join(root, typingInputsReceiptPath(physical));
  if (!existsSync(file)) return undefined;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
    throw new Error('typing inputs: receipt must be a bounded regular file');
  const value = JSON.parse(readFileSync(file, 'utf8')) as TypingInputReceipt;
  const validSnapshot = (snapshot: TypingInputs): boolean =>
    Boolean(
      snapshot &&
      snapshot.version === 1 &&
      ['configured-typescript', 'conservative'].includes(snapshot.profile) &&
      typeof snapshot.runtime === 'string' &&
      Array.isArray(snapshot.excludedDocuments) &&
      snapshot.excludedDocuments.every((file) => typeof file === 'string') &&
      [snapshot.source, snapshot.prepared].every(
        (entries) =>
          Array.isArray(entries) &&
          entries.length <= 100_000 &&
          entries.every(
            (entry) =>
              entry &&
              typeof entry.path === 'string' &&
              entry.path.length <= 4096 &&
              entry.path !== '' &&
              !isAbsolute(entry.path) &&
              !entry.path.split('/').includes('..') &&
              !/[\\\0\r\n]/.test(entry.path) &&
              /^(?:[a-f0-9]{64}|missing)$/.test(entry.digest),
          ),
      ),
    );
  if (
    value.version !== 1 ||
    value.physicalRunId !== physical ||
    !same(value.command, command) ||
    !Array.isArray(value.compilerCommand) ||
    value.compilerCommand.some((arg) => typeof arg !== 'string') ||
    !Number.isInteger(value.exitCode) ||
    typeof value.sourceStable !== 'boolean' ||
    !validSnapshot(value.started) ||
    !validSnapshot(value.completed) ||
    (value.outputs !== undefined &&
      (!same(value.outputs, ['kernel-client-v1']) || !kernelClientTypingPipeline(root, value.compilerCommand))) ||
    value.sourceStable !== stableSource(value.started, value.completed, value.outputs)
  )
    throw new Error('typing inputs: receipt binding or inventory is invalid');
  return value;
}

export type TypingInputQualification = 'matched' | 'source-changed' | 'prepared-changed' | 'evidence-unavailable';

const REMOTE_PREPARATION_MARKERS = new Set([
  '.preparation-started',
  '.remote-check-supervisor',
  'preparation-install.json',
]);

/**
 * A pre-recognition direct Kernel receipt captured the conservative inventory. Project only that legacy snapshot
 * onto the current configured inventory: all admitted source paths still bind exactly, while documents are
 * omitted only when the installed Kernel graph proves they are unconsumed.
 */
function retainedKernelSourceMatches(completed: TypingInputs, current: TypingInputs): boolean {
  if (completed.profile !== 'conservative' || current.profile !== 'configured-typescript') return false;
  const compiled = new Map(completed.source.map((entry) => [entry.path, entry.digest]));
  if (compiled.size !== completed.source.length) return false;
  const currentPaths = new Set(current.source.map((entry) => entry.path));
  if (currentPaths.size !== current.source.length) return false;
  for (const entry of current.source) if (compiled.get(entry.path) !== entry.digest) return false;

  const excludedDocuments = new Set(current.excludedDocuments);
  for (const entry of completed.source) {
    if (currentPaths.has(entry.path)) continue;
    if (excludedDocuments.has(entry.path)) continue;
    if (entry.path.startsWith('.temp/')) continue;
    if (REMOTE_PREPARATION_MARKERS.has(entry.path)) continue;
    return false;
  }
  return true;
}

/** Qualify producer outputs through the existing atomic tree publication; unavailable transport is not a source error. */
export function qualifyTypingInputs(
  root: string,
  receipt: TypingInputReceipt,
  localPrepared: readonly TypingInput[] = [],
): TypingInputQualification {
  // Bun prints usage for `bun --cwd <workspace> run <script>`; the installed owner requires `bun run --cwd`.
  if (misorderedWorkspaceTypecheckIntent(receipt.compilerCommand)) return 'evidence-unavailable';
  const pipeline = kernelClientTypingPipeline(root, receipt.compilerCommand);
  if (!receipt.sourceStable) {
    // Earlier capture knew the exact pipeline but did not declare generation. Never reinterpret it as a pass.
    if (pipeline && stableSource(receipt.started, receipt.completed, ['kernel-client-v1']))
      return 'evidence-unavailable';
    return 'source-changed';
  }
  if (receipt.exitCode !== 0) return 'source-changed';
  const current = captureTypingInputs(root, receipt.compilerCommand);
  if (current.runtime !== receipt.completed.runtime) return 'evidence-unavailable';
  const retainedKernelReceipt =
    directKernelOwnerCommand(receipt.compilerCommand) && retainedKernelSourceMatches(receipt.completed, current);
  if (!same(current.source, receipt.completed.source) && !retainedKernelReceipt) return 'source-changed';
  // This legacy pass is reused only when every installed dependency and generated input remains identical.
  if (retainedKernelReceipt && !same(current.prepared, receipt.completed.prepared)) return 'prepared-changed';
  if (receipt.outputs?.includes('kernel-client-v1')) {
    try {
      const require = createRequire(import.meta.url);
      const owner =
        require('../../../scripts/check-output-tree.ts') as typeof import('../../../scripts/check-output-tree.ts');
      owner.verifyPublishedOutputTree(root, readFileSync(join(root, owner.KERNEL_CLIENT_OUTPUT.transport)));
    } catch {
      return 'evidence-unavailable';
    }
    const generated = (entries: readonly TypingInput[]) =>
      entries.filter((entry) => entry.path.startsWith(GENERATED_CLIENT));
    if (!same(generated(current.prepared), generated(receipt.completed.prepared))) return 'evidence-unavailable';
  }
  const baseline = new Map(localPrepared.map((entry) => [entry.path, entry.digest]));
  const compiled = new Map(receipt.completed.prepared.map((entry) => [entry.path, entry.digest]));
  for (const entry of current.prepared) {
    if (compiled.get(entry.path) === entry.digest || baseline.get(entry.path) === entry.digest) continue;
    return 'prepared-changed';
  }
  for (const entry of localPrepared)
    if (!current.prepared.some((current) => current.path === entry.path) && entry.digest !== 'missing')
      return 'prepared-changed';
  return 'matched';
}

export function typingInputsMatch(
  root: string,
  receipt: TypingInputReceipt,
  localPrepared: readonly TypingInput[] = [],
): boolean {
  return qualifyTypingInputs(root, receipt, localPrepared) === 'matched';
}
