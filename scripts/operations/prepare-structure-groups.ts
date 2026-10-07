import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import { graphObjectReferences } from '../../services/main/src/modules/owner/object-coverage.ts';
import { graphPlacementControl, type GraphPlacementControl } from '../../services/main/src/modules/owner/placement.ts';
import { lockPreservationTarget } from '../../services/main/src/modules/public-report/preservation.ts';
import { StructureGroupRootStore } from '../../services/main/src/modules/structure/group-root.ts';
import { checkStructureManifest, checkStructureSealManifest, STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_SEAL_FORMAT, STRUCTURE_PROFILE } from '../../services/main/src/modules/structure/format.ts';
import { readCompositionHeader } from '../../services/main/src/modules/structure/graph.ts';
import { WORK_READ_COST } from '../../services/main/src/modules/work/read-contract.ts';
import { parseOptions, readEnv, stackDirectory } from '../dev/config.ts';

// Explicit maintenance only. Capture the existing owner reference inventory once
// while admission is held; subsequent bounded turns reuse that fixed cut rather
// than rescanning graph populations. Content checkpoints survive process loss.
// Use a logical held maintenance/restore cut with login-capable owner credentials.
// A physical backup's NOLOGIN source cannot run this command. Existing process
// ACCESS_DATABASE_URL/CONTENT_DATABASE_URL overrides select maintenance logins.
interface PreparationCut { control: GraphPlacementControl; manifests: string[] }
const root = resolve(import.meta.dir, '../..'), args = process.argv.slice(2);
function option(name: string) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(at, 2); return value;
}
const capture = option('--capture-cut'), cutPath = option('--cut'), manifest = option('--manifest');
const turns = Number(option('--turns') ?? 1);
if (Boolean(capture) === Boolean(cutPath) || capture && manifest
  || cutPath && !/^[0-9a-f]{64}$/.test(manifest ?? '')
  || !Number.isInteger(turns) || turns < 1 || turns > 64) {
  throw new Error('Use --capture-cut <file>, or --cut <file> --manifest <original SHA> [--turns 1..64]');
}
const apps = readEnv(join(stackDirectory(root, parseOptions(args)), 'apps.env'));
const graph = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL ?? apps.ACCESS_DATABASE_URL, max: 1,
  connectionTimeoutMillis: 2000, statement_timeout: 5000 });
const content = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL ?? apps.CONTENT_DATABASE_URL, max: 1,
  connectionTimeoutMillis: 2000, statement_timeout: 5000 });
const maintenanceDeadline = Date.now() + 600_000;
let deadline = maintenanceDeadline;
const checkDeadline = () => { if (Date.now() >= deadline) throw new Error('Structure group preparation deadline exceeded'); };
const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
  accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
  region: apps.MAIN_S3_REGION!, prefix: 'semantic/structure/',
  readSignal: () => AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
async function fixedControl(expected?: GraphPlacementControl) {
  checkDeadline();
  const control = await graphPlacementControl(graph);
  if (!control.held || expected && JSON.stringify(control) !== JSON.stringify(expected)) {
    throw new Error('Structure group preparation requires the unchanged held owner cut');
  }
  return control;
}
async function heldAccess() {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (result.rows[0]?.open !== false) throw new Error('Access recovery fence must be held for preparation');
    return client;
  } catch (error) { await client.query('ROLLBACK'); client.release(); throw error; }
}
try {
  if (capture) {
    const client = await heldAccess();
    try {
      const control = await fixedControl();
      const references = await graphObjectReferences(graph);
      const manifests = new Set<string>();
      for (const reference of references) {
        checkDeadline();
        if (reference.model !== STRUCTURE_PROFILE) continue;
        let digest = reference.manifest.slice(-64);
        let bytes = await objects.get(digest);
        const value = JSON.parse(new TextDecoder().decode(bytes)) as { format?: string };
        if (value.format === STRUCTURE_SEAL_FORMAT) {
          digest = checkStructureSealManifest(bytes).structureManifest.slice(7);
          bytes = await objects.get(digest);
        } else if (value.format !== STRUCTURE_MANIFEST_FORMAT) {
          throw new Error('Retained Structure root has an unknown format');
        }
        const source = checkStructureManifest(bytes);
        if (source.profile === 'book-composition' && !source.topGroups) manifests.add(digest);
      }
      await fixedControl(control);
      writeFileSync(resolve(capture), JSON.stringify({ control, manifests: [...manifests].sort() } satisfies PreparationCut));
      await client.query('COMMIT');
      console.log(JSON.stringify({ cut: resolve(capture), manifests: manifests.size }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } else {
    const cut = JSON.parse(readFileSync(resolve(cutPath!), 'utf8')) as PreparationCut;
    if (!cut.control || !Array.isArray(cut.manifests)
      || cut.manifests.some(value => !/^[0-9a-f]{64}$/.test(value)) || !cut.manifests.includes(manifest!)) {
      throw new Error('Original manifest is not in the fixed preparation cut');
    }
    const store = new StructureGroupRootStore(content, objects);
    for (let turn = 0; turn < turns; turn++) {
      deadline = Math.min(maintenanceDeadline, Date.now() + WORK_READ_COST.deadlineMs);
      const client = await heldAccess();
      try {
        await fixedControl(cut.control);
        const source = checkStructureManifest(await objects.get(manifest!));
        const header = await readCompositionHeader({ fuseki: graph,
          lineage: cut.control, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! }, source.structure);
        if (!header || header.component !== source.structureOf || header.profile !== source.profile) {
          throw new Error('Retained Structure owner is unavailable for preservation fencing');
        }
        // Existing Access target lock serializes evidence preservation/erasure;
        // preparation adds only retained order references, never copies bodies.
        await lockPreservationTarget(client, header.owner);
        const checkpoint = await store.prepare(manifest!, { checkDeadline });
        await fixedControl(cut.control);
        await client.query('COMMIT');
        console.log(JSON.stringify(checkpoint));
        if (checkpoint.complete) break;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  }
} finally { await Promise.all([access.end(), content.end()]); }
