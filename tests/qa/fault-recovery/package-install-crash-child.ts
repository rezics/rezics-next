import { Pool } from 'pg';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { PackageInstallationStore, type InstallFault }
  from '../../../services/main/src/modules/package/install.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';

interface CrashInput { rootDirectory: string; principal: string; installation: string;
  generation: string; point: InstallFault }

const input = await Bun.file(process.argv[2]!).json() as CrashInput;
const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 4 });
const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
  bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
  accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
const locks = new PackageLockStore(pool, new NpmResolutionStore(pool),
  new PackageArtifactStore(pool, namespaces));
const store = new PackageInstallationStore(pool, locks, { rootDirectory: input.rootDirectory,
  fault: point => {
    if (point === input.point) process.kill(process.pid, 'SIGKILL');
  } });
await store.apply(input.principal, input.installation, input.generation, async () => true);
await pool.end();
throw new Error(`crash point ${input.point} was not reached`);
