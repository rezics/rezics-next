import { dirname, resolve } from 'node:path';
import { nativeCompiler } from './adapters/compiler-host.ts';
import {
  catalogueFileStore,
  publishCatalogueRoot,
  readCatalogueRootFile,
  catalogueLocalPath,
  readCatalogueLocalBytes,
} from './catalogue-files.ts';
import {
  catalogueFail,
  parseCatalogueJson,
  assertCatalogueDigest,
  assertKindId,
  CATALOGUE_LIMITS,
  type DefinitionTypePin,
} from './catalogue.ts';
import { RELEASE_LIMITS } from './portable.ts';

const usage =
  'Usage: catalogue build --input inputs.json --output directory | verify --root directory/root.json | lookup --root directory/root.json --id prefix:ExactId';
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    catalogueFail('invalid', 'Expected input object');
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!fields.includes(key)) catalogueFail('invalid', `Unknown input field ${key}`);
  return result;
}
async function main(argv: readonly string[]) {
  const [operation, ...args] = argv;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (!key.startsWith('--') || value === undefined || options.has(key)) catalogueFail('invalid', usage);
    options.set(key, value);
  }
  const allowed =
    operation === 'build'
      ? ['--input', '--output']
      : operation === 'lookup'
        ? ['--root', '--id']
        : operation === 'verify'
          ? ['--root']
          : [];
  if (!allowed.length || options.size !== allowed.length || [...options.keys()].some((key) => !allowed.includes(key)))
    catalogueFail('invalid', usage);
  const option = (key: string) => options.get(key)!;
  if (operation === 'build') {
    const inputPath = catalogueLocalPath(option('--input'));
    // The manifest has no total member limit. Each referenced artifact retains its own byte/work envelope.
    const manifest = object(
      parseCatalogueJson(await readCatalogueLocalBytes(inputPath, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER),
      ['releases', 'declarations', 'compatibility'],
    );
    function paths(value: unknown, required: boolean): string[] {
      if (value === undefined && !required) return [];
      if (!Array.isArray(value) || value.some((path) => typeof path !== 'string') || (required && !value.length))
        catalogueFail('invalid', 'Expected explicit artifact path array');
      return value.map((path) => resolve(dirname(inputPath), catalogueLocalPathRelative(path)));
    }
    function catalogueLocalPathRelative(path: string): string {
      // Validate URI/NUL restrictions before resolving relative to the manifest.
      catalogueLocalPath(path);
      return path;
    }
    const releasePaths = paths(manifest.releases, true);
    const declarationPaths = paths(manifest.declarations, false);
    let compatibility: 'all' | DefinitionTypePin[] = [];
    if (manifest.compatibility === 'all') compatibility = 'all';
    else if (manifest.compatibility !== undefined) {
      if (!Array.isArray(manifest.compatibility))
        catalogueFail('invalid', 'compatibility must be "all" or exact Type pins');
      compatibility = manifest.compatibility.map((value) => {
        const pin = object(value, ['releaseDigest', 'typeId']);
        assertCatalogueDigest(pin.releaseDigest);
        assertKindId(pin.typeId);
        return { releaseDigest: pin.releaseDigest, typeId: pin.typeId };
      });
    }
    // Read only explicitly named local data; sequential bounded-file decoding, no dynamic imports or network.
    const releases: unknown[] = [];
    for (const path of releasePaths)
      releases.push(
        parseCatalogueJson(await readCatalogueLocalBytes(path, RELEASE_LIMITS.bytes), RELEASE_LIMITS.bytes),
      );
    const declarations: unknown[] = [];
    for (const path of declarationPaths)
      declarations.push(
        parseCatalogueJson(
          await readCatalogueLocalBytes(path, CATALOGUE_LIMITS.declarationBytes),
          CATALOGUE_LIMITS.declarationBytes,
        ),
      );
    const directory = catalogueLocalPath(option('--output'));
    const pin = await nativeCompiler().buildCatalogue(
      { releases, declarations, compatibility },
      catalogueFileStore(directory),
    );
    await publishCatalogueRoot(directory, pin);
    console.log(JSON.stringify(pin));
  } else {
    const { pin, store } = await readCatalogueRootFile(option('--root'));
    if (operation === 'verify') console.log(JSON.stringify(await nativeCompiler().verifyCatalogue(pin, store)));
    else {
      const result = await nativeCompiler().lookupCatalogueKind(pin, option('--id'), store);
      console.log(JSON.stringify(result));
      if (result.status === 'not-found') process.exitCode = 2;
    }
  }
}
export async function runCatalogueCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await main(argv).catch((error: unknown) => {
    console.error(`catalogue: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
