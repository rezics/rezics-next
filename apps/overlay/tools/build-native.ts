import { randomUUID } from 'node:crypto';
import { copyFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type CargoMessage =
  | { reason: 'compiler-message'; message: { rendered: string | null } }
  | { reason: 'compiler-artifact'; target: { name: string }; executable: string | null }
  | { reason: 'build-script-executed'; package_id: string; out_dir: string };

const loaderName = 'WebView2Loader.dll';
const cargo = Bun.spawn(
  ['cargo', 'build', '--locked', '--release', '--message-format=json', ...process.argv.slice(2)],
  {
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'inherit',
  },
);
const [output, status] = await Promise.all([new Response(cargo.stdout).text(), cargo.exited]);
const windowsOutputs = new Set<string>();
let loaderSource: string | undefined;

for (const line of output.split(/\r?\n/u)) {
  if (!line) continue;
  let event: CargoMessage;
  try {
    event = JSON.parse(line) as CargoMessage;
  } catch {
    console.log(line);
    continue;
  }
  if (event.reason === 'compiler-message' && event.message.rendered) {
    process.stderr.write(event.message.rendered);
  } else if (
    event.reason === 'compiler-artifact' &&
    event.target.name === 'rezics-overlay' &&
    event.executable?.endsWith('.exe')
  ) {
    windowsOutputs.add(dirname(event.executable));
  } else if (event.reason === 'build-script-executed' && event.package_id.includes('#webview2-com-sys@')) {
    // The pinned bindings copy the matching loader to this directory during their Cargo build.
    loaderSource ??= join(event.out_dir, 'x64', loaderName);
  }
}

if (status !== 0) process.exit(status);
if (loaderSource) {
  for (const directory of windowsOutputs) {
    const temporary = join(directory, `.${loaderName}-${randomUUID()}`);
    try {
      await copyFile(loaderSource, temporary);
      await rename(temporary, join(directory, loaderName));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
