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
  outputBinding?: { host: string; run: string };
};
export const typingInputsReceiptPath = (physical: string): string => `.temp/goal/checks/typing-inputs/${physical}.json`;
const GENERATED_CLIENT = 'packages/client/src/kernel/';
const KERNEL_CLIENT_EMITTER = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck', '--emit-client'];
const KERNEL_CLIENT_PIPELINE = [
  'sh',
  '-c',
  'bun run --cwd services/kernel typecheck --emit-client && bun run --cwd packages/client typecheck',
];
const REMOTE_PREPARATION_MARKERS = new Set([
  '.preparation-started',
  '.remote-check-supervisor',
  'preparation-install.json',
]);
const KERNEL_MIGRATION_PATH = /^services\/kernel\/db\/[a-z][a-z0-9_]*\/migrations\/\d{14}_[a-z0-9_]+\.sql$/;
const LEGACY_DBMATE_SETUP_DIAGNOSTIC =
  /^kernel typecheck infrastructure failure: phase=database-setup: dbmate requires each migration to define an up block with ['"]-- migrate:up['"]$/;
const KERNEL_MIGRATION_HEADER_LIMIT_BYTES = 512;
const DBMATE_UP_MARKER = /^-- migrate:up(?:[ \t]+transaction:(?:true|false))?[ \t]*\r?$/m;
const DBMATE_DOWN_MARKER = /^-- migrate:down(?:[ \t]+transaction:(?:true|false))?[ \t]*\r?$/m;
// These are outputs of the owning generation commands, before their compiler programs run.
const producedDuringPreparation = (file: string): boolean =>
  /^apps\/(web|auth)\/src\/(?:paraglide\/|routeTree\.gen\.ts$)/.test(file);
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export type KernelMigrationHeaderDiagnostic = { path: string; line: string };

/** The retained source must be an ordinary migration with a down block and no forward marker. */
function retainedMigrationWithoutUpMarker(
  root: string,
  sourceRelativePath: string,
  files: ReadonlySet<string>,
): boolean {
  if (!KERNEL_MIGRATION_PATH.test(sourceRelativePath) || !files.has(sourceRelativePath)) return false;
  const sourcePath = join(root, sourceRelativePath);
  const normalizedRoot = resolve(root);
  const normalizedSource = resolve(sourcePath);
  const withinKernel = relative(join(normalizedRoot, 'services/kernel'), normalizedSource).replaceAll('\\', '/');
  if (!withinKernel || withinKernel === '..' || withinKernel.startsWith('../') || isAbsolute(withinKernel)) return false;
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(normalizedSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return false;

  const contents = readFileSync(normalizedSource);
  if (contents.byteLength > KERNEL_MIGRATION_HEADER_LIMIT_BYTES) return false;
  const text = contents.toString('utf8');
  return !DBMATE_UP_MARKER.test(text) && DBMATE_DOWN_MARKER.test(text);
}

/** Revalidate current preflight and retained legacy dbmate setup diagnostics against the source tree. */
export function retainedKernelMigrationHeaderDefect(
  root: string,
  log: string,
): KernelMigrationHeaderDiagnostic | undefined {
  const lines = log.split(/\r?\n/);
  let sourceFiles: Set<string> | undefined;
  const files = () => (sourceFiles ??= new Set(gitFiles(root)));
  const starts = lines.flatMap((line, index) => (line === 'Migration version check failed:' ? [index] : []));
  if (starts.length === 1) {
    const start = starts[0]!;
    const end = lines.indexOf('Name migrations with `date -u +%Y%m%d%H%M%S`.', start + 1);
    if (end > start + 1) {
      const issues = lines.slice(start + 1, end);
      if (issues.length === 1) {
        const match = issues[0]!.match(
          /^- (db\/[a-z][a-z0-9_]*\/migrations\/\d{14}_[a-z0-9_]+\.sql): missing dbmate up marker; add `-- migrate:up` before the up SQL$/,
        );
        if (match) {
          const sourceRelativePath = `services/kernel/${match[1]!}`;
          if (retainedMigrationWithoutUpMarker(root, sourceRelativePath, files()))
            return { path: sourceRelativePath, line: issues[0]! };
        }
      }
    }
  }

  const legacyLines = lines.filter((line) => LEGACY_DBMATE_SETUP_DIAGNOSTIC.test(line));
  if (legacyLines.length !== 1) return;
  const inventory = files();
  const candidates = [...inventory]
    .filter((file) => KERNEL_MIGRATION_PATH.test(file))
    .filter((file) => retainedMigrationWithoutUpMarker(root, file, inventory));
  if (candidates.length !== 1) return;
  return { path: candidates[0]!, line: legacyLines[0]! };
}

function gitFiles(root: string): string[] {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`typing inputs: source inventory unavailable: ${run.stderr.trim()}`);
  const files = new Set(run.stdout.split('\0').filter(Boolean));
  // The worker's Git inventory omits ignored files. These exact controls still belong to source custody whenever a
  // local entry exists; their producer ownership can be projected only when qualifying a retained remote receipt.
  for (const marker of REMOTE_PREPARATION_MARKERS) if (localEntryPresent(root, marker)) files.add(marker);
  return [...files].sort();
}

function localEntryPresent(root: string, file: string): boolean {
  try {
    lstatSync(join(root, file));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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

/** Identify a named Kernel client output, including unsupported combinations that must never become root checks. */
export function hasKernelClientOutputIntent(argv: readonly string[]): boolean {
  return (
    (argv[0] === 'bun' || argv[0]?.endsWith('/bun') === true) &&
    argv[1] === 'run' &&
    argv[2] === '--cwd' &&
    argv[3] === 'services/kernel' &&
    argv[4] === 'typecheck' &&
    argv.slice(5).includes('--emit-client')
  );
}

/** The only direct Kernel client emitter that recovery may promote to the validated consumer pipeline. */
export function isKernelClientEmitterIntent(argv: readonly string[]): boolean {
  return argv.length === KERNEL_CLIENT_EMITTER.length && hasKernelClientOutputIntent(argv);
}

/** The structural pipeline is safe to select only as a complete command; manifest validation follows below. */
export function isKernelClientTypingPipelineIntent(argv: readonly string[]): boolean {
  if (argv.length !== 3 || !['sh', 'bash'].includes(argv[0]!) || argv[1] !== '-c' || typeof argv[2] !== 'string')
    return false;
  const steps = argv[2]!.trim().split(/\s*&&\s*/);
  return (
    steps.length === 2 &&
    steps[0]!.trim().replace(/\s+/g, ' ') === 'bun run --cwd services/kernel typecheck --emit-client' &&
    steps[1]!.trim().replace(/\s+/g, ' ') === 'bun run --cwd packages/client typecheck'
  );
}

/** The installed producer/consumer owners, in fail-fast order; arbitrary shell/custom compilers stay conservative. */
export function kernelClientTypingPipeline(root: string, argv: readonly string[]): boolean {
  if (!isKernelClientTypingPipelineIntent(argv)) return false;
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

/** Mirror the installed Kernel emitter's closed schema selector and output-directory rules. */
function installedKernelSchemaEmissionCommand(root: string, argv: readonly string[]): boolean {
  if (
    argv.length !== 6 ||
    argv[0] !== 'bun' ||
    argv[1] !== 'run' ||
    argv[2] !== '--cwd' ||
    argv[3] !== 'services/kernel' ||
    argv[4] !== 'typecheck' ||
    !argv[5]!.startsWith('--emit-schema=')
  )
    return false;
  const schema = argv[5]!.slice('--emit-schema='.length);
  if (schema === 'core') return true;
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || schema === 'migrations') return false;
  try {
    return statSync(join(root, 'services/kernel/db', schema, 'migrations')).isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
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
  } else if (installedKernelSchemaEmissionCommand(root, argv)) {
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

function installedWorkspaceTypecheck(
  root: string,
  command: readonly string[],
  workspace: string,
  packageName: string,
): boolean {
  const exactCommand = ['bun', 'run', '--cwd', workspace, 'typecheck'];
  if (!same(command, exactCommand) || !isKnownTypingCompiler(root, command)) return false;
  const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  return manifest.name === packageName && manifest.scripts?.typecheck === 'bun scripts/typecheck.ts';
}

/** The direct installed Kernel entrypoint has the same configured graph as its manifest typecheck owner. */
export function isDirectKernelTypingCompiler(root: string, command: readonly string[]): boolean {
  return directKernelOwnerCommand(command) && isKnownTypingCompiler(root, command);
}

/** Retained Kernel passes use only the direct owner, installed workspace owner, or exact schema-emission argv. */
export function isRetainedKernelTypingCompiler(root: string, command: readonly string[]): boolean {
  return (
    isDirectKernelTypingCompiler(root, command) ||
    installedWorkspaceTypecheck(root, command, 'services/kernel', '@rezics/kernel') ||
    kernelClientTypingPipeline(root, command) ||
    (installedKernelSchemaEmissionCommand(root, command) && isKnownTypingCompiler(root, command))
  );
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
  if (isKernelClientEmitterIntent(command)) {
    const recovery = [...KERNEL_CLIENT_PIPELINE];
    return isKnownTypingCompiler(root, recovery) ? recovery : undefined;
  }
  if (isKernelClientTypingPipelineIntent(command))
    return isKnownTypingCompiler(root, command) ? [...command] : undefined;
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
        pipeline &&
        (file === '.temp/check-output-tree/kernel-client-v1.bin' ||
          file.startsWith('packages/client/src/.kernel-output-tree/'))
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
  const clientPipeline = kernelClientTypingPipeline(root, compilerCommand);
  const outputs: ['kernel-client-v1'] | undefined = clientPipeline ? ['kernel-client-v1'] : undefined;
  const outputBinding = clientPipeline ? kernelClientOutputBinding(env) : undefined;
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
      ...(outputBinding ? { outputBinding } : {}),
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
  const validCompilerCommand =
    Array.isArray(value.compilerCommand) && value.compilerCommand.every((argument) => typeof argument === 'string');
  const clientPipeline = validCompilerCommand && kernelClientTypingPipeline(root, value.compilerCommand);
  const validOutputs =
    value.outputs === undefined ? !clientPipeline : same(value.outputs, ['kernel-client-v1']) && clientPipeline;
  const validOutputBinding =
    value.outputBinding === undefined || (clientPipeline && isKernelClientOutputBinding(value.outputBinding));
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
    !validCompilerCommand ||
    !Number.isInteger(value.exitCode) ||
    typeof value.sourceStable !== 'boolean' ||
    !validSnapshot(value.started) ||
    !validSnapshot(value.completed) ||
    !validOutputs ||
    !validOutputBinding ||
    value.sourceStable !== stableSource(value.started, value.completed, value.outputs)
  )
    throw new Error('typing inputs: receipt binding or inventory is invalid');
  return value;
}

export type TypingInputQualification = 'matched' | 'source-changed' | 'prepared-changed' | 'evidence-unavailable';

type KernelClientOutputBinding = { host: string; run: string };
const CHECK_HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const CHECK_HOST_RUN = /^[a-z0-9-]{1,64}$/;

function isKernelClientOutputBinding(value: unknown): value is KernelClientOutputBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    Object.keys(binding).sort().join(',') === 'host,run' &&
    typeof binding.host === 'string' &&
    CHECK_HOST_NAME.test(binding.host) &&
    typeof binding.run === 'string' &&
    CHECK_HOST_RUN.test(binding.run)
  );
}

function kernelClientOutputBinding(env: NodeJS.ProcessEnv): KernelClientOutputBinding | undefined {
  const binding = { host: env.REMOTE_CHECK_HOST, run: env.REZICS_CHECK_RUN };
  return isKernelClientOutputBinding(binding) ? binding : undefined;
}

function verifiedPublishedKernelClientOutput(root: string, receipt: TypingInputReceipt): boolean {
  try {
    const outputBinding = receipt.outputBinding;
    if (!outputBinding) return false;
    const require = createRequire(import.meta.url);
    const owner =
      require('../../../scripts/check-output-tree.ts') as typeof import('../../../scripts/check-output-tree.ts');
    const transport = owner.readOutputTreeFile(root, owner.KERNEL_CLIENT_OUTPUT.transport);
    const publicationPath = join(dirname(owner.KERNEL_CLIENT_OUTPUT.root), '.kernel-output-tree/receipt.json');
    const publication = JSON.parse(owner.readOutputTreeFile(root, publicationPath, 4096).toString('utf8')) as {
      authority?: { host?: unknown; run?: unknown };
    };
    if (publication.authority?.host !== outputBinding.host || publication.authority?.run !== outputBinding.run)
      return false;
    owner.verifyPublishedOutputTree(root, transport);
    return true;
  } catch {
    return false;
  }
}

/**
 * A nonzero compiler receipt names an actionable source failure only while its current source closure still matches.
 * The installed Kernel client producer may replace its declared generated declarations during that same physical
 * invocation; that alternate prepared view is usable only when the published output tree belongs to the receipt's
 * physical run and matches the receipt's completed generated inventory.
 */
export function typingFailureInputsMatch(
  root: string,
  receipt: TypingInputReceipt,
  localPrepared: readonly TypingInput[] = [],
): boolean {
  if (!receipt.sourceStable || receipt.exitCode === 0 || !same(receipt.command, receipt.compilerCommand)) return false;
  const pipeline = kernelClientTypingPipeline(root, receipt.compilerCommand);
  if ((receipt.outputs !== undefined) !== pipeline || (pipeline && !same(receipt.outputs, ['kernel-client-v1'])))
    return false;
  if (
    (pipeline && (!receipt.outputBinding || !isKernelClientOutputBinding(receipt.outputBinding))) ||
    (!pipeline && receipt.outputBinding !== undefined)
  )
    return false;

  const current = captureTypingInputs(root, receipt.compilerCommand);
  if (
    current.profile !== receipt.completed.profile ||
    current.runtime !== receipt.completed.runtime ||
    !same(current.excludedDocuments, receipt.completed.excludedDocuments) ||
    !same(current.source, receipt.completed.source)
  )
    return false;

  const generated = (entries: readonly TypingInput[]) =>
    entries.filter((entry) => entry.path.startsWith(GENERATED_CLIENT));
  const currentGenerated = generated(current.prepared);
  const baselineGenerated = generated(localPrepared);
  const startedGenerated = generated(receipt.started.prepared);
  const completedGenerated = generated(receipt.completed.prepared);
  let verifiedOutput = false;
  if (pipeline) {
    const unchangedGeneratedInputs =
      same(currentGenerated, baselineGenerated) &&
      same(baselineGenerated, startedGenerated) &&
      same(startedGenerated, completedGenerated);
    verifiedOutput = same(currentGenerated, completedGenerated) && verifiedPublishedKernelClientOutput(root, receipt);
    if (!unchangedGeneratedInputs && !verifiedOutput) return false;
  }

  const baseline = new Map(localPrepared.map((entry) => [entry.path, entry.digest]));
  const compiled = new Map(receipt.completed.prepared.map((entry) => [entry.path, entry.digest]));
  for (const entry of current.prepared) {
    if (pipeline && entry.path.startsWith(GENERATED_CLIENT)) continue;
    if (compiled.get(entry.path) === entry.digest || baseline.get(entry.path) === entry.digest) continue;
    return false;
  }
  for (const entry of localPrepared) {
    if (pipeline && verifiedOutput && entry.path.startsWith(GENERATED_CLIENT)) continue;
    if (!current.prepared.some((currentEntry) => currentEntry.path === entry.path) && entry.digest !== 'missing')
      return false;
  }
  return true;
}

function stableRemotePreparationMarkers(receipt: TypingInputReceipt): boolean {
  const started = new Map(receipt.started.source.map((entry) => [entry.path, entry.digest]));
  const completed = new Map(receipt.completed.source.map((entry) => [entry.path, entry.digest]));
  if (started.size !== receipt.started.source.length || completed.size !== receipt.completed.source.length)
    return false;
  return [...REMOTE_PREPARATION_MARKERS].every((path) => {
    const before = started.get(path);
    const after = completed.get(path);
    return (
      receipt.started.source.filter((entry) => entry.path === path).length === 1 &&
      receipt.completed.source.filter((entry) => entry.path === path).length === 1 &&
      before !== undefined &&
      before !== 'missing' &&
      before === after
    );
  });
}

function configuredRemotePreparationCompiler(root: string, command: readonly string[]): boolean {
  return (
    installedWorkspaceTypecheck(root, command, 'services/kernel', '@rezics/kernel') ||
    installedWorkspaceTypecheck(root, command, 'apps/web', '@rezics/web')
  );
}

/** Derive the only schema output path from the exact installed Kernel command and its selected module. */
function kernelSchemaOutputPath(root: string, command: readonly string[]): string | undefined {
  if (!installedKernelSchemaEmissionCommand(root, command) || !isKnownTypingCompiler(root, command)) return undefined;
  const schema = command[5]!.slice('--emit-schema='.length);
  return schema === 'core' ? 'services/kernel/db/schema.sql' : `services/kernel/db/${schema}/schema.sql`;
}

function uniqueInputs(entries: readonly TypingInput[]): Map<string, string> | undefined {
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (result.has(entry.path)) return undefined;
    result.set(entry.path, entry.digest);
  }
  return result;
}

/**
 * A physical schema emitter may rewrite its own checked-in dump after compilation. Admit that one delta only when
 * the exact invocation, its before/after inventories and prepared inputs identify the selected output.
 */
function changedKernelSchemaOutput(root: string, receipt: TypingInputReceipt): string | undefined {
  const path = kernelSchemaOutputPath(root, receipt.compilerCommand);
  if (
    !path ||
    receipt.exitCode !== 0 ||
    receipt.sourceStable ||
    receipt.outputs !== undefined ||
    !same(receipt.command, receipt.compilerCommand) ||
    receipt.started.profile !== 'configured-typescript' ||
    receipt.completed.profile !== 'configured-typescript' ||
    receipt.started.runtime !== receipt.completed.runtime ||
    !same(receipt.started.excludedDocuments, receipt.completed.excludedDocuments) ||
    !same(receipt.started.prepared, receipt.completed.prepared) ||
    receipt.sourceStable !== stableSource(receipt.started, receipt.completed)
  )
    return undefined;
  const started = uniqueInputs(receipt.started.source);
  const completed = uniqueInputs(receipt.completed.source);
  if (!started || !completed || started.size !== completed.size) return undefined;
  const before = started.get(path);
  const after = completed.get(path);
  if (!before || !after || before === 'missing' || after === 'missing' || before === after) return undefined;
  for (const [file, digest] of started) {
    const completedDigest = completed.get(file);
    if (completedDigest === undefined || (file !== path && completedDigest !== digest)) return undefined;
  }
  return path;
}

/**
 * Reuse an exact configured Kernel or Web pass after remote-check cleanup only when the full marker trio is the
 * complete source difference. The markers remain in the receipt so their stable physical-run evidence is preserved.
 */
function retainedConfiguredRemotePreparationSourceMatches(
  root: string,
  receipt: TypingInputReceipt,
  current: TypingInputs,
  schemaOutput?: string,
): boolean {
  if (
    receipt.started.profile !== 'configured-typescript' ||
    receipt.completed.profile !== 'configured-typescript' ||
    current.profile !== 'configured-typescript' ||
    (schemaOutput === undefined
      ? !configuredRemotePreparationCompiler(root, receipt.compilerCommand)
      : kernelSchemaOutputPath(root, receipt.compilerCommand) !== schemaOutput) ||
    !stableRemotePreparationMarkers(receipt)
  )
    return false;

  const files = gitFiles(root);
  const graph = compilerGraph(root, receipt.compilerCommand, files);
  if (!graph) return false;
  const configured = configuredInputs(root, files, graph);
  if ([...REMOTE_PREPARATION_MARKERS].some((path) => configured.paths.has(path) || configured.documents.has(path)))
    return false;

  const completedPaths = new Set(receipt.completed.source.map((entry) => entry.path));
  const currentPaths = new Set(current.source.map((entry) => entry.path));
  if (completedPaths.size !== receipt.completed.source.length || currentPaths.size !== current.source.length)
    return false;
  const missingMarkers = [...REMOTE_PREPARATION_MARKERS].filter(
    (path) => completedPaths.has(path) && !currentPaths.has(path),
  );
  const preparedPaths = new Set([
    ...receipt.started.prepared.map((entry) => entry.path),
    ...receipt.completed.prepared.map((entry) => entry.path),
    ...current.prepared.map((entry) => entry.path),
  ]);
  if (
    missingMarkers.length !== REMOTE_PREPARATION_MARKERS.size ||
    [...REMOTE_PREPARATION_MARKERS].some(
      (path) => currentPaths.has(path) || localEntryPresent(root, path) || preparedPaths.has(path),
    )
  )
    return false;

  const projected = receipt.completed.source.filter((entry) => !REMOTE_PREPARATION_MARKERS.has(entry.path));
  if (schemaOutput === undefined) return same(current.source, projected);

  const currentInputs = uniqueInputs(current.source);
  const startedInputs = uniqueInputs(receipt.started.source);
  const completedInputs = uniqueInputs(receipt.completed.source);
  if (!currentInputs || !startedInputs || !completedInputs || currentInputs.size !== projected.length) return false;
  const inputDigest = startedInputs.get(schemaOutput);
  const outputDigest = completedInputs.get(schemaOutput);
  if (!inputDigest || !outputDigest || inputDigest === 'missing' || outputDigest === 'missing') return false;
  return projected.every((entry) => {
    const digest = currentInputs.get(entry.path);
    if (digest === undefined) return false;
    return entry.path === schemaOutput ? digest === inputDigest || digest === outputDigest : digest === entry.digest;
  });
}

/**
 * Project a legacy Kernel inventory onto the installed graph only when every admitted source still binds. The
 * remote-check owner validates these three reserved controls against the physical run before a successful terminal;
 * only their stable, now-absent source entries can be projected. Local entries, compiler inputs and other artifacts
 * remain part of identity.
 */
function retainedKernelSourceMatches(root: string, receipt: TypingInputReceipt, current: TypingInputs): boolean {
  const { completed } = receipt;
  if (completed.profile !== 'conservative' || current.profile !== 'configured-typescript') return false;
  const directKernel = directKernelOwnerCommand(receipt.compilerCommand);
  const schemaEmission = installedKernelSchemaEmissionCommand(root, receipt.compilerCommand);
  if (!directKernel && !schemaEmission) return false;
  const files = gitFiles(root);
  const graph = compilerGraph(root, receipt.compilerCommand, files);
  if (!graph) return false;
  const configured = configuredInputs(root, files, graph);
  const compiled = new Map(completed.source.map((entry) => [entry.path, entry.digest]));
  if (compiled.size !== completed.source.length) return false;
  const currentPaths = new Set(current.source.map((entry) => entry.path));
  if (currentPaths.size !== current.source.length) return false;
  for (const entry of current.source) if (compiled.get(entry.path) !== entry.digest) return false;

  const excludedDocuments = new Set(current.excludedDocuments);
  const missingMarkers = [...REMOTE_PREPARATION_MARKERS].filter(
    (path) => compiled.has(path) && !currentPaths.has(path),
  );
  const preparedPaths = new Set([
    ...receipt.started.prepared.map((entry) => entry.path),
    ...receipt.completed.prepared.map((entry) => entry.path),
  ]);
  const projectRemoteMarkers =
    missingMarkers.length > 0 &&
    missingMarkers.length === REMOTE_PREPARATION_MARKERS.size &&
    stableRemotePreparationMarkers(receipt) &&
    [...REMOTE_PREPARATION_MARKERS].every(
      (path) =>
        !currentPaths.has(path) &&
        !localEntryPresent(root, path) &&
        !configured.paths.has(path) &&
        !configured.documents.has(path) &&
        !preparedPaths.has(path),
    );

  for (const entry of completed.source) {
    if (currentPaths.has(entry.path)) continue;
    if (excludedDocuments.has(entry.path)) continue;
    if (directKernel && entry.path.startsWith('.temp/')) continue;
    if (projectRemoteMarkers && REMOTE_PREPARATION_MARKERS.has(entry.path)) continue;
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
  if (
    (receipt.outputs !== undefined && !same(receipt.outputs, ['kernel-client-v1'])) ||
    pipeline !== (receipt.outputs !== undefined)
  )
    return 'evidence-unavailable';
  const schemaOutput = !receipt.sourceStable ? changedKernelSchemaOutput(root, receipt) : undefined;
  if (!receipt.sourceStable) {
    // Earlier capture knew the exact pipeline but did not declare generation. Never reinterpret it as a pass.
    if (!schemaOutput && pipeline && stableSource(receipt.started, receipt.completed, ['kernel-client-v1']))
      return 'evidence-unavailable';
    if (!schemaOutput) return 'source-changed';
  }
  if (receipt.exitCode !== 0) return 'source-changed';
  const current = captureTypingInputs(root, receipt.compilerCommand);
  if (current.runtime !== receipt.completed.runtime) return 'evidence-unavailable';
  const sameSource = same(current.source, receipt.completed.source);
  const retainedKernelReceipt =
    !sameSource &&
    isRetainedKernelTypingCompiler(root, receipt.compilerCommand) &&
    retainedKernelSourceMatches(root, receipt, current);
  const retainedConfiguredRemotePreparationReceipt =
    !sameSource && retainedConfiguredRemotePreparationSourceMatches(root, receipt, current, schemaOutput);
  if (!sameSource && !retainedKernelReceipt && !retainedConfiguredRemotePreparationReceipt) return 'source-changed';
  // This legacy pass is reused only when every installed dependency and generated input remains identical.
  if (retainedKernelReceipt && !same(current.prepared, receipt.completed.prepared)) return 'prepared-changed';
  if (schemaOutput && !same(current.prepared, receipt.completed.prepared)) return 'prepared-changed';
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
