import type { VisualNovelInspection } from '@rezics/launcher-contract';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isPortableSaveName } from './saved-worlds.ts';
import { fileInfo, isMissing } from './storage.ts';
import { inspectKirikiri } from './visual-novel-kirikiri.ts';
import {
  displayMetadata,
  metadataText,
  quotedMetadataString,
  readMetadataBytes,
  unknownVisualNovel,
  type LocalVisualNovelInspection,
} from './visual-novel-metadata.ts';

const fields = { name: 'title', version: 'version', save_directory: 'saveName' } as const;
type MetadataField = (typeof fields)[keyof typeof fields];
type Delimiter = '"""' | "'''";
const directLiteral = new RegExp('^' + quotedMetadataString + '[ \\t]*(?:#.*)?$');
const translatedLiteral = new RegExp('^_[ \\t]*\\([ \\t]*' + quotedMetadataString + '[ \\t]*\\)[ \\t]*(?:#.*)?$');

export function isRenpySaveName(value: string) {
  return value.length <= 120 && !/[\p{Cc}]/u.test(value) && isPortableSaveName(value);
}

export async function renpySaveDirectory(executable: string, workingDirectory: string, name: string) {
  const override = process.env.RENPY_PATH_TO_SAVES;
  if (override !== undefined) return override ? resolve(workingDirectory, override, name) : undefined;

  let directory = dirname(executable);
  for (;;) {
    const marker = join(directory, "Ren'Py Data");
    const info = await stat(marker).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    if (info?.isDirectory()) return join(marker, name);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (process.platform === 'win32') return resolve(workingDirectory, process.env.APPDATA ?? homedir(), 'RenPy', name);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'RenPy', name);
  return join(homedir(), '.renpy', name);
}

async function readMetadataText(path: string) {
  const file = await readMetadataBytes(path);
  if (file) return metadataText(file.bytes, 'utf-8');
}

// A Ren'Py options file may include multiline strings such as gui.about.
function multilineDelimiter(line: string, delimiter: Delimiter | undefined): Delimiter | undefined {
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === '\\') {
      i++;
    } else if (delimiter) {
      if (line.startsWith(delimiter, i)) {
        delimiter = undefined;
        i += 2;
      }
    } else if (character === '#') {
      break;
    } else if (character === '"' || character === "'") {
      const triple = character === '"' ? '"""' : "'''";
      if (line.startsWith(triple, i)) {
        delimiter = triple;
        i += 2;
      } else {
        for (i++; i < line.length && line[i] !== character; i++) {
          if (line[i] === '\\') i++;
        }
      }
    }
  }
  return delimiter;
}

function literal(expression: string, field: MetadataField): string | undefined {
  // Admit a plain quoted literal or Ren'Py's standard translation wrapper.
  const quoted = (field === 'title' ? translatedLiteral.exec(expression) : null) ?? directLiteral.exec(expression);
  const decoded = (quoted?.[1] ?? quoted?.[2])?.replace(/\\(["'\\])/g, '$1');
  if (field === 'saveName') return decoded && isRenpySaveName(decoded) ? decoded : undefined;
  return displayMetadata(decoded);
}

async function readBuildInfo(game: string): Promise<Pick<VisualNovelInspection, 'title' | 'version'>> {
  const cache = join(game, 'cache');
  if (!(await fileInfo(cache))?.isDirectory()) return {};
  const text = await readMetadataText(join(cache, 'build_info.json'));
  if (text === undefined) return {};
  try {
    const record: unknown = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
    const { name, version: buildVersion } = record as Record<string, unknown>;
    const title = displayMetadata(name);
    const version = displayMetadata(buildVersion);
    return { ...(title && { title }), ...(version && { version }) };
  } catch {
    return {};
  }
}

function readDeclarations(source: string): VisualNovelInspection {
  const values = new Map<MetadataField, string | undefined>();
  let delimiter: Delimiter | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (!delimiter) {
      const found = /^[ \t]*define[ \t]+config\.(name|version|save_directory)[ \t]*=[ \t]*(.*)$/.exec(line);
      if (found) {
        const field = fields[found[1] as keyof typeof fields];
        values.set(field, values.has(field) ? undefined : literal(found[2] ?? '', field));
      }
    }
    delimiter = multilineDelimiter(line, delimiter);
  }

  const metadata: VisualNovelInspection = { engine: values.size ? 'renpy' : 'unknown' };
  for (const [field, value] of values) {
    if (value !== undefined) metadata[field] = value;
  }
  return metadata;
}

async function hasRenpyRuntime(directory: string) {
  const runtime = join(directory, 'renpy');
  return (await fileInfo(runtime))?.isDirectory() && (await fileInfo(join(runtime, 'common')))?.isDirectory();
}

export async function hasRenpyBootstrap(executable: string, extension: string) {
  if (extension === '.py') return false;
  const script = await readMetadataText(executable.slice(0, -extension.length) + '.py');
  return Boolean(script?.includes('def path_to_gamedir(') && script.includes('renpy.bootstrap.bootstrap('));
}

async function renpyGameDirectory(executable: string, directory: string) {
  // Ren’Py tries the executable stem and the suffix after each space or underscore.
  const stem = basename(executable).split('.', 1)[0]!;
  const names = [stem, ...Array.from(stem.matchAll(/[ _]/g), ({ index }) => stem.slice(index + 1))];
  const candidates = new Set([...names, 'game', 'data', 'launcher/game', '']);
  for (const candidate of candidates) {
    if (candidate === 'renpy') continue;
    const parts = candidate ? candidate.split('/') : [];
    let current = directory;
    let complete = true;
    for (const part of parts) {
      current = join(current, part);
      const entry = await fileInfo(current);
      if (entry?.isSymbolicLink()) return;
      if (!entry?.isDirectory()) {
        complete = false;
        break;
      }
    }
    if (complete) return current;
  }
}

async function inspectRenpy(
  executable: string,
  directory: string,
  bundled: boolean,
): Promise<LocalVisualNovelInspection> {
  const packageDirectories = bundled ? [join(directory, 'renpy'), join(directory, 'lib')] : [];
  const game = await renpyGameDirectory(executable, directory);
  if (!game) return { metadata: { engine: bundled ? 'renpy' : 'unknown' }, packageDirectories };
  const options = await readMetadataText(join(game, 'options.rpy'));
  const metadata: VisualNovelInspection = options === undefined ? { engine: 'unknown' } : readDeclarations(options);
  if (metadata.engine === 'unknown' && !bundled && !(await fileInfo(join(game, 'options.rpyc')))?.isFile()) {
    return unknownVisualNovel();
  }
  metadata.engine = 'renpy';
  metadata.gameSaveDirectory = join(game, 'saves');
  packageDirectories.push(game === directory ? metadata.gameSaveDirectory : game);
  return {
    metadata: metadata.title && metadata.version ? metadata : { ...(await readBuildInfo(game)), ...metadata },
    packageDirectories,
  };
}

export async function inspectVisualNovelInstallation(
  executable: string,
  directory: string,
): Promise<LocalVisualNovelInspection> {
  const base = dirname(executable);
  const bundled = Boolean(await hasRenpyRuntime(base));
  const workingRuntime = base !== directory && !bundled && Boolean(await hasRenpyRuntime(directory));
  const renpy = await inspectRenpy(executable, bundled ? base : directory, bundled || workingRuntime);
  return renpy.metadata.engine === 'renpy' ? renpy : inspectKirikiri(executable);
}
