import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REQUIRED_PER_MESSAGE_MODULE,
  ensureMessagesReady,
  generatedMessageModules,
  messagesCurrent,
  prepareLiveMessages,
} from './messages-ready.ts';
import { processIdentity } from '../tests/support/server-custody.ts';

const wrapperSource = readFileSync(join(import.meta.dir, 'isolated.ts'), 'utf8');

function makeApp(): { directory: string; cleanup: () => void; calls: string; output: string; messages: string } {
  const directory = mkdtempSync(join(tmpdir(), 'web-messages-ready-'));
  const messages = join(directory, 'messages');
  const output = join(directory, 'src/paraglide/messages.js');
  const calls = join(directory, 'generate-calls.log');
  mkdirSync(messages, { recursive: true });
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(
    join(directory, 'scripts/generate.ts'),
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n` +
      `import { join } from 'node:path';\n` +
      `const root = process.cwd();\n` +
      `appendFileSync(join(root, 'generate-calls.log'), 'generate\\n');\n` +
      `writeFileSync(join(root, 'generate-executable'), process.execPath);\n` +
      `if ((await import('node:fs')).existsSync(join(root, 'fail-generation'))) process.exit(37);\n` +
      `mkdirSync(join(root, 'src/paraglide/messages'), { recursive: true });\n` +
      `writeFileSync(join(root, 'src/paraglide/messages.js'), "export * from './messages/_index.js';\\nexport * as m from './messages/_index.js';\\n");\n` +
      `writeFileSync(join(root, 'src/paraglide/runtime.js'), 'export const locales = ["en"];\\n');\n` +
      `writeFileSync(join(root, 'src/paraglide/messages/_index.js'), "export * from './access_account.js';\\n");\n` +
      `writeFileSync(join(root, 'src/paraglide/messages/access_account.js'), 'export const access_account = () => "Account";\\n');\n`,
  );
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    calls,
    output,
    messages,
  };
}

function recordCalls(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

test('live preparation uses the pinned disposable compiler and preserves its failure status', async () => {
  const app = makeApp();
  try {
    writeFileSync(
      join(app.directory, 'scripts/prepare-live-messages.ts'),
      `import { writeFileSync } from 'node:fs';
       writeFileSync('live-runtime', process.execPath);
       process.exitCode = 37;`,
    );
    expect(await prepareLiveMessages(app.directory, { ...process.env, PATH: '' })).toBe(37);
    expect(readFileSync(join(app.directory, 'live-runtime'), 'utf8')).toBe(process.execPath);
    expect(existsSync(join(app.directory, '.temp/paraglide-generate.lock'))).toBe(false);
    expect(recordCalls(app.calls)).toEqual([]);
  } finally {
    app.cleanup();
  }
});

function setMtime(file: string, milliseconds: number): void {
  const seconds = milliseconds / 1000;
  utimesSync(file, seconds, seconds);
}

type MessageModuleFixture = { id: string; filename: string; exportedName: string };

function generatedModuleSource(module: MessageModuleFixture): string {
  const declaration = `const ${module.exportedName} = () => ${JSON.stringify(module.id)};`;
  if (module.id === module.exportedName) return `export ${declaration}\n`;
  return `${declaration}\nexport { ${module.exportedName} as ${JSON.stringify(module.id)} };\n`;
}

function writeGeneratedOutput(
  app: ReturnType<typeof makeApp>,
  catalogueModules: MessageModuleFixture[] = [],
  omittedFiles: string[] = [],
): string[] {
  const output = join(app.directory, 'src/paraglide');
  const leaves = join(output, 'messages');
  const modules = [
    { id: 'access_account', filename: REQUIRED_PER_MESSAGE_MODULE, exportedName: 'access_account' },
    ...catalogueModules.filter((module) => module.filename !== REQUIRED_PER_MESSAGE_MODULE),
  ];
  const omitted = new Set(omittedFiles);
  mkdirSync(leaves, { recursive: true });
  writeFileSync(app.output, "export * from './messages/_index.js';\nexport * as m from './messages/_index.js';\n");
  writeFileSync(join(output, 'runtime.js'), 'export const locales = ["en"];\n');
  const index = join(leaves, '_index.js');
  writeFileSync(index, modules.map((module) => `export * from './${module.filename}';`).join('\n') + '\n');
  const generated = [app.output, join(output, 'runtime.js'), index];
  for (const module of modules) {
    if (omitted.has(module.filename)) continue;
    const path = join(leaves, module.filename);
    writeFileSync(path, generatedModuleSource(module));
    generated.push(path);
  }
  return generated;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

test('missing Paraglide messages are generated once before bun test runs', async () => {
  const app = makeApp();
  const missingBunPath = { ...process.env, PATH: '' };
  try {
    writeFileSync(join(app.messages, 'en.json'), '{}');

    expect(await ensureMessagesReady(app.directory, missingBunPath)).toBe(0);
    expect(existsSync(app.output)).toBe(true);
    expect(recordCalls(app.calls)).toEqual(['generate']);
    expect(readFileSync(join(app.directory, 'generate-executable'), 'utf8')).toBe(process.execPath);

    expect(await ensureMessagesReady(app.directory, missingBunPath)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('fresh output with every catalogue leaf is reused', async () => {
  const app = makeApp();
  try {
    const messageFiles = [
      'de.json',
      'en.json',
      'es.json',
      'fr.json',
      'ja.json',
      'ko.json',
      'zh-Hans.json',
      'zh-Hant.json',
    ];
    for (const name of messageFiles) writeFileSync(join(app.messages, name), '{}');
    const generated = writeGeneratedOutput(app);
    const base = Date.now() - 60_000;
    for (const [index, name] of messageFiles.entries()) setMtime(join(app.messages, name), base + index * 1000);
    for (const file of generated) setMtime(file, base + 10_000);

    expect(messagesCurrent(app.directory)).toBe(true);
    expect(await ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual([]);
  } finally {
    app.cleanup();
  }
});

test('partial output is completed before it becomes current and later startup reuses it', async () => {
  const app = makeApp();
  try {
    writeFileSync(join(app.messages, 'en.json'), JSON.stringify({ access_account: 'Account' }));
    mkdirSync(join(app.directory, 'src/paraglide'), { recursive: true });
    mkdirSync(join(app.directory, 'src/paraglide/messages'), { recursive: true });
    writeFileSync(app.output, "export * from './messages/_index.js';\nexport * as m from './messages/_index.js';\n");
    writeFileSync(
      join(app.directory, 'src/paraglide/messages/_index.js'),
      `export * from './${REQUIRED_PER_MESSAGE_MODULE}';\n`,
    );
    writeFileSync(join(app.directory, 'src/paraglide/runtime.js'), 'fresh');
    const base = Date.now() - 60_000;
    setMtime(join(app.messages, 'en.json'), base);
    setMtime(app.output, base + 10_000);

    expect(messagesCurrent(app.directory)).toBe(false);
    expect(await ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
    expect(existsSync(join(app.directory, 'src/paraglide/messages/access_account.js'))).toBe(true);
    expect(messagesCurrent(app.directory)).toBe(true);
    expect(await ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('simultaneous preparation callers share one compile and recheck freshness under the lock', async () => {
  const app = makeApp();
  try {
    writeFileSync(join(app.messages, 'en.json'), '{}');

    expect(await Promise.all([ensureMessagesReady(app.directory), ensureMessagesReady(app.directory)])).toEqual([0, 0]);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('canceling message preparation settles the generator process group before releasing its lock', async () => {
  if (process.platform === 'win32') return;
  const app = makeApp();
  const descendantPidFile = join(app.directory, 'compiler-descendant.pid');
  const abort = new AbortController();
  let preparation: Promise<number> | undefined;
  try {
    writeFileSync(
      join(app.directory, 'scripts/generate.ts'),
      `import { spawn } from 'node:child_process';\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n` +
        `descendant.once('spawn', () => writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid)));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    preparation = ensureMessagesReady(app.directory, { ...process.env, PATH: '' }, { signal: abort.signal });
    await waitForFile(descendantPidFile);
    const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));

    abort.abort('SIGTERM');
    expect(await preparation).toBe(143);
    const identity = processIdentity(descendantPid);
    expect(identity === undefined || identity.state === 'Z').toBe(true);
    expect(existsSync(join(app.directory, '.temp/paraglide-generate.lock'))).toBe(false);
  } finally {
    abort.abort('SIGTERM');
    try {
      await preparation;
    } finally {
      app.cleanup();
    }
  }
}, 15_000);

test('messages newer than the output cause generation again', async () => {
  const app = makeApp();
  try {
    const message = join(app.messages, 'en.json');
    writeFileSync(message, '{}');
    const generated = writeGeneratedOutput(app);
    const base = Date.now() - 60_000;
    for (const file of generated) setMtime(file, base);
    setMtime(message, base + 10_000);

    expect(await ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('generation failure returns its exit code and prevents tests from starting', async () => {
  const app = makeApp();
  try {
    writeFileSync(join(app.messages, 'en.json'), '{}');
    writeFileSync(join(app.directory, 'fail-generation'), '');

    expect(await ensureMessagesReady(app.directory)).toBe(37);
    expect(recordCalls(app.calls)).toEqual(['generate']);
    expect(existsSync(app.output)).toBe(false);

    const callbackStart = wrapperSource.indexOf('async (slotEnvironment) => {');
    const readinessCall = wrapperSource.indexOf('ensureMessagesReady(app, slotEnvironment)');
    const spawn = wrapperSource.indexOf('Bun.spawn(invocation');
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(readinessCall).toBeGreaterThan(callbackStart);
    expect(spawn).toBeGreaterThan(readinessCall);
    expect(wrapperSource.slice(readinessCall, spawn)).toMatch(/if \(messageCode !== 0\) return messageCode;/u);
  } finally {
    app.cleanup();
  }
});

test('catalogue readiness follows Paraglide filenames and exported IDs for normalized keys', () => {
  const app = makeApp();
  try {
    const modules: MessageModuleFixture[] = [
      {
        id: 'knowledge_reference_documentId',
        filename: 'knowledge_reference_documentid1.js',
        exportedName: 'knowledge_reference_documentid1',
      },
      { id: 'HelloWorld', filename: 'helloworld2.js', exportedName: 'helloworld2' },
      { id: 'import', filename: '_import.js', exportedName: '_import' },
      { id: 'error-type', filename: 'error_type.js', exportedName: 'error_type' },
      { id: '123 values', filename: '_123_values.js', exportedName: '_123_values' },
    ];
    writeFileSync(join(app.messages, 'en.json'), JSON.stringify(Object.fromEntries(modules.map(({ id }) => [id, id]))));
    writeGeneratedOutput(app, modules);

    expect(generatedMessageModules(readFileSync(app.output, 'utf8'))).toEqual(['./messages/_index.js']);
    expect(messagesCurrent(app.directory)).toBe(true);

    const missingFile = join(app.directory, 'src/paraglide/messages', modules[0]!.filename);
    rmSync(missingFile);
    expect(messagesCurrent(app.directory)).toBe(false);
    writeFileSync(missingFile, generatedModuleSource(modules[0]!));
    expect(messagesCurrent(app.directory)).toBe(true);

    const index = join(app.directory, 'src/paraglide/messages/_index.js');
    writeFileSync(
      index,
      [
        "export * from './access_account.js';",
        ...modules.slice(1).map((module) => `export * from './${module.filename}';`),
      ].join('\n') + '\n',
    );
    expect(messagesCurrent(app.directory)).toBe(false);
    writeFileSync(
      index,
      [
        "export * from './access_account.js';",
        ...modules.map((module) => `export * from './${module.filename}';`),
      ].join('\n') + '\n',
    );
    expect(messagesCurrent(app.directory)).toBe(true);
  } finally {
    app.cleanup();
  }
});

test('a successful compile stops when the same normalized catalogue output stays missing', async () => {
  const app = makeApp();
  const id = 'knowledge_reference_documentId';
  const filename = 'knowledge_reference_documentid1.js';
  try {
    const message = join(app.messages, 'en.json');
    writeFileSync(message, JSON.stringify({ [id]: 'Document ID' }));
    const generated = writeGeneratedOutput(
      app,
      [{ id, filename, exportedName: 'knowledge_reference_documentid1' }],
      [filename],
    );
    const base = Date.now() - 60_000;
    setMtime(message, base);
    for (const file of generated) setMtime(file, base + 10_000);

    writeFileSync(
      join(app.directory, 'scripts/generate.ts'),
      `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `const root = process.cwd();\n` +
        `appendFileSync(join(root, 'generate-calls.log'), 'generate\\n');\n` +
        `mkdirSync(join(root, 'src/paraglide/messages'), { recursive: true });\n` +
        `writeFileSync(join(root, 'src/paraglide/messages.js'), "export * from './messages/_index.js';\\nexport * as m from './messages/_index.js';\\n");\n` +
        `writeFileSync(join(root, 'src/paraglide/runtime.js'), 'export const locales = ["en"];\\n');\n` +
        `writeFileSync(join(root, 'src/paraglide/messages/_index.js'), "export * from './access_account.js';\\nexport * from './${filename}';\\n");\n` +
        `writeFileSync(join(root, 'src/paraglide/messages/access_account.js'), 'export const access_account = () => "Account";\\n');\n`,
    );

    await expect(ensureMessagesReady(app.directory)).rejects.toThrow(
      /Paraglide compiler exited successfully without completing output;.*knowledge_reference_documentId/u,
    );
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('isolated wrapper checks readiness only for bun test, inside the local or check-host callback', () => {
  const callbackStart = wrapperSource.indexOf('async (slotEnvironment) => {');
  const readinessCall = wrapperSource.indexOf('ensureMessagesReady(app, slotEnvironment)');
  const commandCondition = wrapperSource.indexOf("appCommand[0] === 'bun' && appCommand[1] === 'test'");
  const firstRun = wrapperSource.indexOf('for (const run of commands)');
  const spawn = wrapperSource.indexOf('Bun.spawn(invocation');

  expect(wrapperSource).toContain("from './messages-ready.ts'");
  expect(commandCondition).toBeGreaterThan(callbackStart);
  expect(readinessCall).toBeGreaterThan(commandCondition);
  expect(firstRun).toBeGreaterThan(readinessCall);
  expect(spawn).toBeGreaterThan(firstRun);
  expect(wrapperSource).toMatch(
    /const routedCommand = selection\s*\?\s*\['bun', 'scripts\/isolated\.ts', '--routed-selection'\]/u,
  );
  expect(wrapperSource).toContain('command: routedCommand');
  expect(wrapperSource).toContain("command[0] === 'bun' && command[1] === 'test'");
});
