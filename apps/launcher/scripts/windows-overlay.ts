import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const loaderName = 'WebView2Loader.dll';
const coffHeaderSize = 20;
const sectionHeaderSize = 40;
const pe32PlusDirectoryCount = 108;
const pe32PlusDirectories = 112;
const importDescriptorSize = 20;

function readX64Header(bytes: Buffer, name: string, dll: boolean) {
  const invalid = new Error(`${name} must be a valid Windows x64 ${dll ? 'DLL' : 'executable'}.`);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw invalid;
  const pe = bytes.readUInt32LE(0x3c);
  const coff = pe + 4;
  const optional = coff + coffHeaderSize;
  if (optional > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw invalid;
  const machine = bytes.readUInt16LE(coff);
  const sectionCount = bytes.readUInt16LE(coff + 2);
  const optionalSize = bytes.readUInt16LE(coff + 16);
  const characteristics = bytes.readUInt16LE(coff + 18);
  const sections = optional + optionalSize;
  if (
    machine !== 0x8664 ||
    (characteristics & 0x0002) === 0 ||
    Boolean(characteristics & 0x2000) !== dll ||
    sectionCount === 0 ||
    sectionCount > 96 ||
    sections + sectionCount * sectionHeaderSize > bytes.length ||
    optionalSize < pe32PlusDirectories ||
    bytes.readUInt16LE(optional) !== 0x20b
  )
    throw invalid;
  return { optional, sections, sectionCount };
}

function importsWebView2Loader(bytes: Buffer, name: string) {
  const { optional, sections, sectionCount } = readX64Header(bytes, name, false);
  const invalid = new Error(`Could not read the Windows import table in ${name}.`);

  function bytesAtRva(rva: number) {
    for (let index = 0; index < sectionCount; index++) {
      const entry = sections + index * sectionHeaderSize;
      const sectionRva = bytes.readUInt32LE(entry + 12);
      const fileSize = bytes.readUInt32LE(entry + 16);
      const fileOffset = bytes.readUInt32LE(entry + 20);
      const withinSection = rva - sectionRva;
      if (withinSection < 0 || withinSection >= fileSize) continue;
      if (fileOffset + fileSize > bytes.length) throw invalid;
      return bytes.subarray(fileOffset + withinSection, fileOffset + fileSize);
    }
    throw invalid;
  }

  // The PE32+ data-directory entry after Export describes ordinary DLL imports.
  if (bytes.readUInt32LE(optional + pe32PlusDirectoryCount) < 2) return false;
  const directory = optional + pe32PlusDirectories + 8;
  if (directory + 8 > sections) throw invalid;
  const imports = bytes.readUInt32LE(directory);
  const size = bytes.readUInt32LE(directory + 4);
  if (imports === 0 && size === 0) return false;
  if (imports === 0 || size < importDescriptorSize) throw invalid;
  const table = bytesAtRva(imports);
  if (size > table.length) throw invalid;
  let requiresLoader = false;
  for (let offset = 0; offset + importDescriptorSize <= size; offset += importDescriptorSize) {
    const entry = table.subarray(offset, offset + importDescriptorSize);
    if (entry.every((byte) => byte === 0)) return requiresLoader;
    const nameRva = entry.readUInt32LE(12);
    if (!nameRva) throw invalid;
    const file = bytesAtRva(nameRva);
    const end = file.indexOf(0);
    if (end <= 0) throw invalid;
    if (file.toString('ascii', 0, end).toLowerCase() === loaderName.toLowerCase()) requiresLoader = true;
  }
  throw invalid;
}

export async function readWindowsOverlayFiles(path: string) {
  const executable = await readFile(path);
  if (!importsWebView2Loader(executable, basename(path))) return { executable };

  const loader = await readFile(join(dirname(path), loaderName)).catch((cause: unknown) => {
    throw new Error(`This Overlay imports ${loaderName}. Place the Windows x64 DLL beside the executable.`, { cause });
  });
  readX64Header(loader, loaderName, true);
  return { executable, loader };
}
