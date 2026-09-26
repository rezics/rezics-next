import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerfileCopySources, fusekiBuildInputs, fusekiImageTag, stampFusekiImage }
  from '../../../scripts/dev/fuseki-image.ts';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';

const root = join(import.meta.dir, '../../..');

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-fuseki-image-'));
  for (const path of ['infra/jena', 'infra/dev/compose.yaml', 'generated/model/manifest.json',
    'generated/model/shapes']) cpSync(join(root, path), join(directory, path), { recursive: true });
  return directory;
}

test('build inputs follow the Dockerfile COPY sources and skip multi-stage copies', () => {
  expect(dockerfileCopySources('FROM a AS b\nCOPY --chown=1:1 x/y.txt z/ /dest/\nCOPY --from=b /out /out\n'))
    .toEqual(['x/y.txt', 'z']);
  const inputs = fusekiBuildInputs(root);
  expect(inputs).toContain('infra/jena/Dockerfile');
  expect(inputs).toContain('infra/jena/command-module/pom.xml');
  expect(inputs).toContain('infra/jena/fuseki-text.ttl');
  expect(inputs.some(path => path.startsWith('infra/jena/command-module/src/main/java/'))).toBe(true);
  expect(inputs.some(path => path.startsWith('generated/model/shapes/'))).toBe(true);
  expect(inputs).not.toContain('infra/jena/tests/command.integration.test.ts');
});

test('the Compose Fuseki tag is derived from build inputs and changes with any of them', () => {
  const directory = fixture();
  try {
    const before = fusekiImageTag(directory);
    expect(before).toMatch(/^rezics\/fuseki:6\.2\.0-cmd\d+\.\d+\.\d+-[0-9a-f]{12}$/);
    const assembler = join(directory, 'infra/jena/fuseki-text.ttl');
    writeFileSync(assembler, `${readFileSync(assembler, 'utf8')}\n# changed\n`);
    const after = fusekiImageTag(directory);
    expect(after).not.toBe(before);
    expect(() => stampFusekiImage(directory, true)).toThrow('run yarn gen');
    stampFusekiImage(directory, false);
    expect(fusekiImageFromCompose(readFileSync(join(directory, 'infra/dev/compose.yaml'), 'utf8')).image).toBe(after);
    expect(() => stampFusekiImage(directory, true)).not.toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a hand-written Compose tag is replaced by the derived tag', () => {
  const directory = fixture();
  try {
    const path = join(directory, 'infra/dev/compose.yaml');
    const compose = readFileSync(path, 'utf8');
    writeFileSync(path, compose.replace(/^ {4}image: rezics\/fuseki:\S+$/m, '    image: rezics/fuseki:6.2.0-cmd0.5.29-scalar1'));
    stampFusekiImage(directory, false);
    expect(fusekiImageFromCompose(readFileSync(path, 'utf8')).image).toBe(fusekiImageTag(directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the checked-in Compose topology pins the derived Fuseki tag', () => {
  expect(fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image)
    .toBe(fusekiImageTag(root));
});
