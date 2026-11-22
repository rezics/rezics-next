import type { HostCommandDeclaration, Instance } from '@rezics/launcher-contract';
import { createRezicsLibraryReader } from '@rezics/launcher-core';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { version } from '../package.json';
import {
  automationDeclaration,
  describeAutomationCommands,
  automationNeedsRunningHost,
  isAutomationCommand,
  type AutomationRequest,
} from '../src/main/automation-commands';
import { automationError, type AutomationResult } from '../src/main/automation-types';
import { automationFrameLimit, sendAutomation } from '../src/main/automation-transport';
import { createLauncherHost, LauncherProfileBusyError, type LauncherHost } from '../src/main/host';
import { optionalText, record, text } from '../src/main/rpc-values';
import { readPackagedMinecraftClientId } from '../src/shared/minecraft-client';

declare const REZICS_PACKAGED_LAUNCHER_HOST: boolean;
const resources =
  typeof REZICS_PACKAGED_LAUNCHER_HOST !== 'undefined' && REZICS_PACKAGED_LAUNCHER_HOST
    ? resolve(dirname(process.execPath), 'resources')
    : undefined;
const catalogUrl = process.env.REZICS_CATALOG_URL ?? 'https://api.rezics.com';
const locale = Intl.DateTimeFormat().resolvedOptions().locale;

const localCommands = {
  'read-library': { input: 'json', description: 'Read a REZICS shelf using a credential from standard input.' },
  run: { input: 'path', argument: 'module', description: 'Run a local JavaScript or TypeScript module.' },
  serve: { input: 'none', description: 'Keep the selected Launcher profile open to commands.' },
} as const satisfies Record<string, HostCommandDeclaration>;

for (const name of Object.keys(localCommands)) {
  if (isAutomationCommand(name)) throw new Error(`Duplicate Launcher command: ${name}.`);
}

type CommandDescription = HostCommandDeclaration & { name: string; plugin?: string };

function describeCommand(declaration: CommandDescription) {
  if (declaration.input === 'none') return declaration;
  const argument = declaration.argument ?? (declaration.input === 'text' ? 'value' : 'file');
  const stdin =
    declaration.name === 'read-library'
      ? 'credential'
      : declaration.input === 'json' || declaration.input === 'json-with-base'
        ? 'json'
        : undefined;
  return { ...declaration, argument, ...(stdin && { stdin }) };
}

const commandDescriptions = [
  ...describeAutomationCommands(),
  ...Object.entries(localCommands).map(([name, info]) => ({ name, ...info })),
].map(describeCommand);

function usage() {
  const commands = commandDescriptions.map((entry) =>
    entry.input === 'none' ? `  ${entry.name}` : `  ${entry.name} <${entry.argument}>`,
  );
  return [
    'host --data-dir <folder> <command> [argument]',
    'host --help | --commands',
    ...commands,
    'Use - for piped JSON in place of a JSON file. read-library reserves standard input for the credential.',
  ].join('\n');
}

const [flag, directory, command, input, ...extra] = process.argv.slice(2);
const declaration = isAutomationCommand(command)
  ? automationDeclaration(command)
  : command && Object.hasOwn(localCommands, command)
    ? localCommands[command as keyof typeof localCommands]
    : undefined;

if (flag === '--help') {
  console.log(usage());
} else if (flag === '--commands') {
  console.log(JSON.stringify({ schemaVersion: 1, commands: commandDescriptions }));
} else if (
  flag !== '--data-dir' ||
  !directory ||
  !command ||
  !declaration ||
  extra.length ||
  (declaration.input === 'none' ? !!input : !input)
) {
  console.error(usage());
  process.exitCode = 1;
} else {
  try {
    await invoke(resolve(directory), command, input ?? '');
  } catch (error) {
    console.error(automationError(error));
    process.exitCode = 1;
  }
}

async function invoke(dataDir: string, command: string, input: string) {
  if (command === 'read-library') {
    await readLibrary(dataDir, input);
    return;
  }
  if (isAutomationCommand(command)) {
    const cancel = new AbortController();
    const interrupt = () => cancel.abort(new Error('The Launcher command was interrupted.'));
    process.on('SIGINT', interrupt);
    try {
      print(await localAutomation(dataDir, await createRequest(command, input, cancel.signal), cancel.signal));
    } finally {
      process.off('SIGINT', interrupt);
    }
    return;
  }
  if (command === 'serve') {
    await serveHost(dataDir);
    return;
  }
  const host = await openHost(dataDir);
  try {
    const script = await import(pathToFileURL(resolve(input)).href);
    if (typeof script.default !== 'function')
      throw new Error('Export a default function that receives the Launcher host.');
    await script.default(host);
  } finally {
    await host.close();
  }
}

async function openHost(dataDir: string, onTerminalQuit?: () => void) {
  const overlayExecutable = resources ? resolve(resources, 'rezics-overlay.exe') : process.env.REZICS_OVERLAY_PATH;
  const minecraftClientId = resources
    ? await readPackagedMinecraftClientId(resources)
    : process.env.REZICS_MINECRAFT_CLIENT_ID;
  return createLauncherHost({
    dataDir,
    catalogUrl,
    webUrl: process.env.REZICS_WEB_URL ?? 'https://rezics.com',
    launcherVersion: version,
    locale,
    ...(overlayExecutable && { overlayExecutable: resolve(overlayExecutable) }),
    ...(minecraftClientId && { minecraftClientId }),
    ...(onTerminalQuit && { automation: { onTerminalQuit } }),
    openExternal: async (url) => console.error(url),
  });
}

async function localAutomation(dataDir: string, request: AutomationRequest, signal?: AbortSignal) {
  let host: LauncherHost;
  try {
    signal?.throwIfAborted();
    host = await openHost(dataDir);
  } catch (error) {
    if (!(error instanceof LauncherProfileBusyError)) throw error;
    return sendAutomation(dataDir, request, signal);
  }
  try {
    if (automationNeedsRunningHost(request.command)) {
      if (request.command === 'quit-host')
        throw new Error('Start the terminal host with serve before requesting quit.');
      const purpose = request.command === 'start-game' ? 'starting a game' : `running ${request.command}`;
      throw new Error(`Open Launcher or start the terminal host with serve before ${purpose}.`);
    }
    return await host.automate(request, signal);
  } finally {
    await host.close();
  }
}

async function createRequest(
  command: AutomationRequest['command'],
  input: string,
  signal: AbortSignal,
): Promise<AutomationRequest> {
  const { input: format } = automationDeclaration(command);
  if (format === 'none') return { command };
  if (format === 'text') return { command, argument: input };
  const file = resolve(input);
  if (format === 'path') return { command, argument: file };
  const base = input === '-' ? process.cwd() : dirname(file);
  const value = input === '-' ? await readStdinJson(signal) : await readJson(file);
  if (format === 'json-with-base') return { command, argument: { base, batch: value } };
  if (command === 'export-backup' || command === 'import-backup') {
    const fields = record(value);
    return { command, argument: { ...fields, folder: resolve(base, text(fields.folder, 32_767)) } };
  }
  return { command, argument: value };
}

function print(result: AutomationResult) {
  console.log(JSON.stringify(result.value));
  if (result.partial) process.exitCode = 2;
}

async function readLibrary(dataDir: string, input: string) {
  if (input === '-')
    throw new Error('Supply a Library query file. Standard input is reserved for the REZICS credential.');
  const fields = record(await readJson(resolve(input)));
  const { kind, installedOnly } = fields;
  if (kind !== 'visual-novels' && kind !== 'video-games') throw new Error('Choose a REZICS Library shelf.');
  if (installedOnly !== undefined && typeof installedOnly !== 'boolean') {
    throw new Error('Use a boolean for the Installed filter.');
  }
  const cursor = optionalText(fields.cursor, 4096);
  const read = createRezicsLibraryReader(
    catalogUrl,
    async (signal) => {
      const { value } = await localAutomation(dataDir, { command: 'list-installed' }, signal);
      if (!Array.isArray(value)) throw new Error('The Launcher host did not return an installation list.');
      return value as Instance[];
    },
    readToken,
    locale,
  );
  const result = await read({ kind, ...(cursor && { cursor }), ...(installedOnly && { installedOnly }) });
  console.log(JSON.stringify(result));
  if (result.status !== 'ready') process.exitCode = 2;
}

async function serveHost(dataDir: string) {
  const quit = Promise.withResolvers<void>();
  const host = await openHost(dataDir, quit.resolve);
  const request = host.requestTerminalQuit;
  process.on('SIGINT', request);
  process.on('SIGTERM', request);
  try {
    console.log(JSON.stringify({ status: 'ready' }));
    await quit.promise;
    await host.waitForTerminalWork();
  } finally {
    try {
      await host.close();
    } finally {
      process.off('SIGINT', request);
      process.off('SIGTERM', request);
    }
  }
}

async function readToken(signal?: AbortSignal) {
  if (process.stdin.isTTY) return;
  const bytes = await readStdin(16_384, 'The REZICS authorization is too large.', signal);
  return bytes.toString('utf8').trim();
}

async function readStdinJson(signal: AbortSignal): Promise<unknown> {
  const bytes = await readStdin(automationFrameLimit, 'This JSON input is too large. Use a smaller batch.', signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Supply one UTF-8 JSON value on standard input.');
  }
}

async function readStdin(limit: number, sizeError: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of signal ? addAbortSignal(signal, process.stdin) : process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error(sizeError);
    chunks.push(bytes);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, size);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}
