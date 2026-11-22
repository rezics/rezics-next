import { basename, dirname, extname, join } from 'node:path';
import { isPortableSaveName } from './saved-worlds.ts';
import { fileInfo } from './storage.ts';
import {
  displayMetadata,
  metadataText,
  quotedMetadataString,
  readMetadataBytes,
  unknownVisualNovel,
  type LocalVisualNovelInspection,
} from './visual-novel-metadata.ts';
import { inspectXp3 } from './visual-novel-xp3.ts';

const literal = new RegExp('^' + quotedMetadataString + '$', 'u');
const kagStartup = /^[ \t]*Scripts\.execStorage[ \t]*\([ \t]*["']system\/Initialize\.tjs["'][ \t]*\)[ \t]*;[ \t]*$/mu;

function readKirikiriText(bytes: Buffer | undefined) {
  if (!bytes) return;
  if (bytes[0] === 255 && bytes[1] === 254) return metadataText(bytes, 'utf-16le');
  return metadataText(bytes, 'utf-8') ?? metadataText(bytes, 'shift_jis');
}

function withoutComments(source: string) {
  return source.replace(
    /"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu,
    (token) => (token.startsWith('/') ? token.replace(/[^\r\n]/gu, ' ') : token),
  );
}

function quotedValue(expression: string) {
  const matches = literal.exec(expression);
  return (matches?.[1] ?? matches?.[2])?.replace(/\\(["'\\])/gu, '$1');
}

function readKagFields(startupBytes: Buffer | undefined, configBytes: Buffer | undefined) {
  const startup = readKirikiriText(startupBytes);
  const config = readKirikiriText(configBytes);
  if (!startup || !config || !kagStartup.test(withoutComments(startup))) return;
  const fields = new Map<string, string | undefined>();
  for (const line of withoutComments(config).split(/\r?\n/u)) {
    const assignment =
      /^[ \t]*;?[ \t]*(global\.config_version|System\.title|saveDataLocation)[ \t]*=[ \t]*(.*?)[ \t]*;[ \t]*$/u.exec(
        line,
      );
    if (assignment) {
      const [, field, expression] = assignment;
      fields.set(field!, fields.has(field!) ? undefined : expression);
    }
  }
  const marker = fields.get('global.config_version');
  if (marker !== undefined && quotedValue(marker) !== undefined) return fields;
}

async function readKag(directory: string) {
  const system = join(directory, 'system');
  if (!(await fileInfo(system))?.isDirectory() || !(await fileInfo(join(system, 'Initialize.tjs')))?.isFile()) return;
  const startup = await readMetadataBytes(join(directory, 'startup.tjs'));
  const config = await readMetadataBytes(join(system, 'Config.tjs'));
  return readKagFields(startup?.bytes, config?.bytes);
}

async function engineDataFolder(executable: string) {
  const path = join(dirname(executable), basename(executable, extname(executable)) + '.cf');
  const file = await readMetadataBytes(path);
  if (!file) return;
  const values = [...file.bytes.toString('latin1').matchAll(/^datapath=([^\r\n]*)$/gmu)];
  if (values.length !== 1) return;
  const value = values[0]![1]!;
  if (!/^[\x20-\x7e]+$/u.test(value)) return;
  const decoded = /^["']/u.test(value) ? quotedValue(value) : value;
  const relative = /^\$\(exepath\)[\\/](.*)$/u.exec(decoded ?? '')?.[1];
  if (relative && !relative.includes('$(')) return relative;
}

async function localSaveFolder(base: string, relative: string | undefined) {
  if (!relative || Buffer.byteLength(relative) > 480) return;
  const parts = relative.replace(/[/\\]$/u, '').split(/[/\\]/u);
  if (parts.length > 4 || parts.some((part) => !isPortableSaveName(part))) return;
  let target = base;
  for (const part of parts) {
    target = join(target, part);
    const entry = await fileInfo(target);
    if (entry && !entry.isDirectory()) return;
  }
  return target;
}

async function kirikiriReport(
  executable: string,
  kag?: Map<string, string | undefined>,
  looseContent?: string,
): Promise<LocalVisualNovelInspection> {
  const title = displayMetadata(quotedValue(kag?.get('System.title') ?? ''));
  const location = kag?.get('saveDataLocation');
  const relative =
    !kag?.has('saveDataLocation') || location === 'System.dataPath'
      ? await engineDataFolder(executable)
      : quotedValue(location ?? '');
  const directory = dirname(executable);
  const detectedSaveDirectory = await localSaveFolder(directory, relative);
  const packageDirectories = ['system', 'plugin', 'plugin64'].map((name) => join(directory, name));
  if (looseContent && looseContent !== directory) packageDirectories.push(looseContent);
  return {
    metadata: {
      engine: 'kirikiri',
      ...(title && title !== '吉里吉里' && { title }),
      ...(detectedSaveDirectory && { detectedSaveDirectory }),
    },
    packageDirectories,
  };
}

export async function inspectKirikiri(executable: string): Promise<LocalVisualNovelInspection> {
  const directory = dirname(executable);
  if (extname(executable).toLowerCase() !== '.exe' || !(await fileInfo(directory))?.isDirectory())
    return unknownVisualNovel();
  const content = join(directory, 'content-data');
  const contentEntry = await fileInfo(content);
  if (contentEntry) {
    const kag = contentEntry.isDirectory() && (await readKag(content));
    return kag ? kirikiriReport(executable, kag, content) : unknownVisualNovel();
  }
  const archive = join(directory, 'data.xp3');
  const companion = basename(executable).toLowerCase() === 'data.exe' ? executable : join(directory, 'data.exe');
  const external = (await fileInfo(archive)) ? archive : (await fileInfo(companion)) ? companion : undefined;
  const container = external ?? executable;
  const packed = await inspectXp3(container, container === executable);
  if (packed) {
    const report = await kirikiriReport(executable, readKagFields(packed.scripts?.startup, packed.scripts?.config));
    return container === executable ? { ...report, launchEvidence: 'kirikiri-embedded-xp3' } : report;
  }
  if (external) return unknownVisualNovel();
  const data = join(directory, 'data');
  const loose = await fileInfo(data);
  const kag = loose && !loose.isDirectory() ? undefined : await readKag(loose ? data : directory);
  return kag ? kirikiriReport(executable, kag, loose ? data : directory) : unknownVisualNovel();
}
