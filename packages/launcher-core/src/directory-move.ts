import { rename } from 'node:fs/promises';
import { getSystemErrorName } from 'node:util';

const currentDirectory = -100; // AT_FDCWD
const noReplace = 1; // RENAME_NOREPLACE

export type LinuxDirectoryRename = (source: string, destination: string) => Promise<number>;

export async function renameLinuxDirectory(source: string, destination: string): Promise<number> {
  // Electron supplies a Bun helper. Loading Bun's intrinsic only at the call site keeps the desktop bundle runnable.
  const moduleName = 'bun:ffi';
  const { dlopen, FFIType, read } = (await import(moduleName)) as typeof import('bun:ffi');
  const libc = dlopen('libc.so.6', {
    renameat2: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  try {
    const from = Buffer.from(source + '\0');
    const to = Buffer.from(destination + '\0');
    const errno = libc.symbols.__errno_location()!;
    const result = libc.symbols.renameat2(currentDirectory, from, currentDirectory, to, noReplace);
    if (result === 0) return 0;
    const status = read.i32(errno, 0);
    if (status <= 0) throw new Error('Linux could not report the result of moving the directory.');
    return status;
  } finally {
    libc.close();
  }
}

export async function moveDirectoryIfVacant(
  source: string,
  destination: string,
  linuxRename: LinuxDirectoryRename = renameLinuxDirectory,
) {
  if (process.platform !== 'linux') return rename(source, destination);
  const status = await linuxRename(source, destination);
  if (status === 0) return;
  const code = getSystemErrorName(-status);
  const message = ['EINVAL', 'ENOSYS', 'ENOTSUP'].includes(code)
    ? 'The destination filesystem does not support moving a directory without replacing an existing directory.'
    : `Could not move the directory (${code}).`;
  throw Object.assign(new Error(message), { code });
}
