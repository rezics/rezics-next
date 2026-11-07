/** Compiler evidence is narrower than budget/source custody. Unknown runners retain the complete source tree. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type ts from 'typescript';

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
            Buffer.concat([Buffer.from(`link\0${readlinkSync(join(root, file))}\0`), readFileSync(join(root, file))]),
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

/** Only these documented owning compiler commands permit a configured graph. A custom command keeps every file. */
function knownCompiler(root: string, argv: readonly string[], files: readonly string[]): boolean {
  if (!(argv[0] === 'bun' && argv[1] === 'scripts/typecheck.ts')) return false;
  const known = new Set([
    'bun check --no-script -p tsconfig.json',
    'bun scripts/typecheck.ts',
    'bun scripts/typecheck.ts --root',
    'bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json',
  ]);
  for (const file of files.filter((file) => /^(apps|services|packages)\/[^/]+\/package.json$/.test(file))) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as { scripts?: Record<string, string> };
    for (const name of ['typecheck', 'typecheck:root'])
      if (manifest.scripts?.[name] && !known.has(manifest.scripts[name]!)) return false;
    for (const name of ['generate', 'generate:routes']) {
      const script = manifest.scripts?.[name];
      if (
        script &&
        ![
          'bun scripts/generate.ts',
          'node .storybook/generate-routes.ts',
          'vite build --config vite.config.ts --mode development --emptyOutDir false',
        ].includes(script)
      )
        return false;
    }
  }
  return files.some((file) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file));
}

/** Config parsing uses TypeScript's own include/extends semantics, including ignored generated root files. */
function configuredInputs(root: string, files: readonly string[]): { paths: Set<string>; documents: Set<string> } {
  const compiler = createRequire(import.meta.url)('typescript') as typeof ts;
  const paths = new Set<string>();
  const documents = new Set<string>();
  const configs = files.filter(
    (file) => file === 'tsconfig.json' || /^(?:apps|services|packages)\/[^/]+\/tsconfig(?:\.[^/]+)?\.json$/.test(file),
  );
  if (configs.length === 0) throw new Error('typing inputs: no owning compiler configurations');
  const host: ts.ParseConfigFileHost = {
    ...compiler.sys,
    readFile(file) {
      const inside = localPath(root, file);
      if (inside && !inside.split('/').includes('node_modules')) paths.add(inside);
      return compiler.sys.readFile(file);
    },
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  for (const config of configs) {
    const parsed = compiler.getParsedCommandLineOfConfigFile(join(root, config), {}, host);
    if (!parsed) throw new Error(`typing inputs: config unavailable: ${config}`);
    // A custom external mapper can read inputs outside TypeScript's import graph.
    const raw = compiler.readConfigFile(join(root, config), compiler.sys.readFile).config as {
      contentMappers?: { package?: string; extensions?: string[] }[];
    };
    if (raw.contentMappers?.some((mapper) => mapper.package !== 'reylo' || !same(mapper.extensions, ['.sql'])))
      throw new Error('typing inputs: custom mapper');
    for (const file of parsed.fileNames) {
      const inside = localPath(root, file);
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
  for (const file of paths) {
    if (!existsSync(join(root, file))) continue;
    const source = readFileSync(join(root, file), 'utf8');
    const imports = compiler.preProcessFile(source, true, true);
    for (const dependency of [...imports.importedFiles, ...imports.referencedFiles]) {
      const resolved = compiler.resolveModuleName(
        dependency.fileName,
        join(root, file),
        {
          moduleResolution: compiler.ModuleResolutionKind.Bundler,
          allowJs: true,
        },
        compiler.sys,
      ).resolvedModule?.resolvedFileName;
      const target = localPath(root, resolved ?? resolve(root, dirname(file), dependency.fileName));
      if (target && !target.split('/').includes('node_modules')) paths.add(target);
    }
    // Runtime generators may read assets as data. Ordinary compiler source literals are not executed;
    // imported assets above remain covered. Unknown generation commands already select conservative mode.
    if (!/(?:^|\/)(?:scripts\/(?:generate|typecheck)\.ts|\.storybook\/.*\.ts|vite\.config\.ts)$/.test(file)) continue;
    for (const match of source.matchAll(/['"`]([^'"`\r\n]*\.md)(?:\?[^'"`\r\n]*)?['"`]/g)) {
      const literal = match[1]!;
      if (/[*?${}]/.test(literal)) {
        for (const document of candidates) documents.add(document);
      } else {
        for (const document of byName.get(literal.split('/').at(-1)!) ?? []) documents.add(document);
      }
    }
  }
  for (const file of paths) if (file.endsWith('.md')) documents.add(file);
  return { paths, documents };
}

/** Full Git-visible unknown/custom inputs stay covered; only documents outside the configured compiler graph drop out. */
export function captureTypingInputs(root: string, compilerCommand: readonly string[]): TypingInputs {
  root = resolve(root);
  const files = gitFiles(root);
  let profile: TypingInputs['profile'] = 'conservative';
  let configured = { paths: new Set<string>(), documents: new Set<string>() };
  if (knownCompiler(root, compilerCommand, files)) {
    try {
      configured = configuredInputs(root, files);
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
  const sourceFiles = files.filter((file) => !excluded.has(file) && !file.startsWith(GENERATED_CLIENT));
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

function stableSource(started: TypingInputs, completed: TypingInputs): boolean {
  // Preparation can make a config graph available. Compare every admitted source using the completed exclusion set;
  // a source added or changed during compilation still prevents a pass, including an imported former document.
  const excluded = new Set(completed.excludedDocuments);
  return (
    same(
      started.source.filter((entry) => !excluded.has(entry.path)),
      completed.source,
    ) &&
    same(
      started.prepared.filter((entry) => !producedDuringPreparation(entry.path)),
      completed.prepared.filter((entry) => !producedDuringPreparation(entry.path)),
    )
  );
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
      sourceStable: stableSource(started, completed),
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
    value.sourceStable !== stableSource(value.started, value.completed)
  )
    throw new Error('typing inputs: receipt binding or inventory is invalid');
  return value;
}

export function typingInputsMatch(
  root: string,
  receipt: TypingInputReceipt,
  localPrepared: readonly TypingInput[] = [],
): boolean {
  if (!receipt.sourceStable || receipt.exitCode !== 0) return false;
  const current = captureTypingInputs(root, receipt.compilerCommand);
  if (current.runtime !== receipt.completed.runtime || !same(current.source, receipt.completed.source)) return false;
  const baseline = new Map(localPrepared.map((entry) => [entry.path, entry.digest]));
  const compiled = new Map(receipt.completed.prepared.map((entry) => [entry.path, entry.digest]));
  // Remote-only derived inputs are recorded in the compiler receipt. Local generated inputs must remain at the
  // compiled value or their unchanged pre-run value; a return can legitimately replace a pre-run declaration.
  for (const entry of current.prepared) {
    if (compiled.get(entry.path) === entry.digest || baseline.get(entry.path) === entry.digest) continue;
    return false;
  }
  for (const entry of localPrepared)
    if (!current.prepared.some((current) => current.path === entry.path) && entry.digest !== 'missing') return false;
  return true;
}
