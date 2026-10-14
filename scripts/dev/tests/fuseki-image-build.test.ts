import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFusekiImage, fusekiImageLock } from '../fuseki-image-build.ts';
import { fusekiImageTag } from '../fuseki-image.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(build: string) {
  const scratch = join(import.meta.dir, '../../../.temp/image-command-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'image-'));
  roots.push(root);
  mkdirSync(join(root, 'infra/jena/command-module'), { recursive: true });
  writeFileSync(join(root, 'infra/jena/Dockerfile'), 'ARG FUSEKI_VERSION=6.2.0\nCOPY infra/jena/command-module/pom.xml /build/pom.xml\n');
  writeFileSync(join(root, 'infra/jena/command-module/pom.xml'), '<artifactId>fuseki-command</artifactId><version>0.1.0</version>');
  const docker = join(root, 'docker');
  writeFileSync(docker, `#!/bin/sh\nif [ "$1" = image ]; then test -f "${root}/present"; exit $?; fi\nprintf '%s\\n' "$*" >> "${root}/builds"\n${build}\n`, { mode: 0o755 });
  const output = openSync(join(root, 'output'), 'w');
  return { root, output, options: { docker, output, env: { REZICS_STACK_PROFILE: 'dev' }, lockDirectory: join(root, 'locks') } };
}

test('a concurrent caller waits for the first build and reuses its tag; an existing tag starts nothing', async () => {
  const f = fixture('touch "$PWD/started"; while [ ! -f "$PWD/release" ]; do sleep 0.02; done; touch "$PWD/present"');
  const other = fixture('exit 99');
  try {
    const first = ensureFusekiImage(f.root, f.options);
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.root, 'started'))) {
      if (Date.now() >= deadline) throw new Error('first build never started');
      await Bun.sleep(20);
    }
    let returned = false;
    const second = ensureFusekiImage(other.root, f.options).then(tag => { returned = true; return tag; });
    await Bun.sleep(100);
    expect(returned).toBe(false);
    expect(readFileSync(join(f.root, 'builds'), 'utf8').trim().split('\n')).toHaveLength(1);
    writeFileSync(join(f.root, 'release'), '');
    const tag = fusekiImageTag(f.root);
    expect(await Promise.all([first, second])).toEqual([tag, tag]);
    await ensureFusekiImage(f.root, f.options);
    expect(readFileSync(join(f.root, 'builds'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(f.root, 'output'), 'utf8')).toContain(`Image present: ${tag}`);
  } finally { writeFileSync(join(f.root, 'release'), ''); closeSync(f.output); closeSync(other.output); }
}, 10_000);

test('a failed build releases the lock and a retry can build the same tag', async () => {
  const f = fixture('if [ ! -f "$PWD/retry" ]; then exit 23; fi; touch "$PWD/present"');
  try {
    await expect(ensureFusekiImage(f.root, f.options)).rejects.toThrow('exit 23');
    writeFileSync(join(f.root, 'retry'), '');
    await ensureFusekiImage(f.root, f.options);
    expect(readFileSync(join(f.root, 'builds'), 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { closeSync(f.output); }
}, 10_000);

test('different tags have different locks shared by checkouts on this host', () => {
  const f = fixture('exit 0');
  try {
    const tag = fusekiImageTag(f.root);
    expect(fusekiImageLock(tag, f.options.lockDirectory)).toBe(fusekiImageLock(tag, f.options.lockDirectory));
    expect(fusekiImageLock(tag, f.options.lockDirectory)).not.toBe(fusekiImageLock(`${tag}-changed`, f.options.lockDirectory));
  } finally { closeSync(f.output); }
});
