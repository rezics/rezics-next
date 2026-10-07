import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeJwt } from 'jose';
import { HttpBootstrapApi } from './api.ts';
import { executeBootstrap, verifyBootstrap, type BootstrapResult } from './execute.ts';
import { digest, openJournal } from './journal.ts';
import { inside, loadPlan } from './plan.ts';
import { verifyPlatformGovernance, verifyProductionOpening, type BootstrapOperator } from './platform-grant.ts';
import { checkProductionEnv, readProductionEnv } from '../production-env.ts';

const root = resolve(import.meta.dir, '../../..');
function options(args: string[]) {
  const values: Record<string, string> = {};
  let verify = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (
      !['--plan', '--env', '--main', '--account', '--mode'].includes(arg) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith('--') ||
      values[arg]
    )
      throw new Error('Invalid bootstrap arguments');
    values[arg] = args[++index]!;
  }
  if (
    !values['--plan'] ||
    !values['--main'] ||
    !values['--account'] ||
    !['production', 'qa'].includes(values['--mode'] ?? 'production')
  ) {
    throw new Error(
      'Use --plan <file> --main <origin> --account <origin> [--env <file>] [--mode qa] [--verify]',
    );
  }
  const production = values['--mode'] !== 'qa';
  for (const name of ['--main', '--account']) {
    const url = new URL(values[name]!);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!production && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      (production ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol))
    )
      throw new Error('Bootstrap requires HTTPS production origins or loopback QA origins');
  }
  if (production && !values['--env']) throw new Error('Production bootstrap requires --env');
  return { values, production, verify };
}

/** Local single-writer journal lock. A killed process leaves a PID, which can
 * be reclaimed only when the OS says that process no longer exists. */
async function lock(file: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error('Bootstrap lock needs operator inspection');
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          await rm(file);
          continue;
        }
        throw probe;
      }
      throw new Error('Another bootstrap process owns this launch journal');
    }
  }
  throw new Error('Bootstrap lock could not be acquired');
}

export async function run(args: string[]): Promise<void> {
  const startedAt = Date.now();
  const { values, production, verify } = options(args);
  if (production) {
    const env = readProductionEnv(inside(root, values['--env']!));
    checkProductionEnv(env);
    if (env.MAIN_ORIGIN !== values['--main'] || env.ACCOUNT_BASE_URL !== values['--account']) {
      throw new Error('Bootstrap origins differ from the checked production environment');
    }
  }
  const { plan, zones } = await loadPlan(root, values['--plan']!, production);
  const token = Bun.env.BOOTSTRAP_MAIN_TOKEN,
    cookie = Bun.env.BOOTSTRAP_ACCOUNT_COOKIE;
  if (!token || !cookie)
    throw new Error('Set BOOTSTRAP_MAIN_TOKEN and BOOTSTRAP_ACCOUNT_COOKIE for the operator');
  const operator = plan.operators[0]!;
  // Identity labels are compared here; Main performs signature, current-state
  // and scope verification on every authenticated request.
  const claims = decodeJwt(token);
  if (typeof claims.iss !== 'string' || claims.iss.length === 0)
    throw new Error('Bearer token has no account issuer');
  if (claims.sub !== operator.accountSubject)
    throw new Error('Bearer principal differs from the launch operator');
  const bootstrapOperator: BootstrapOperator = {
    issuer: claims.iss,
    accountSubject: operator.accountSubject,
    actor: operator.actingSubject,
  };
  const account = new URL(values['--account']!).origin;
  const accountRead = async (path: string) => {
    const response = await fetch(`${account}${path}`, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Account bootstrap prerequisite failed: HTTP ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const session = (await accountRead('/api/auth/get-session')) as { user?: { id?: string } };
  const authority = await accountRead('/api/account/admin/me');
  if (session.user?.id !== operator.accountSubject || authority.role !== 'owner') {
    throw new Error('Account one-time owner bootstrap has not admitted this operator');
  }
  const folder = inside(root, `.temp/bootstrap/${plan.namespace}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const unlock = await lock(`${folder}/lock`);
  try {
    const api = new HttpBootstrapApi(
      values['--main']!,
      () => Bun.env.BOOTSTRAP_MAIN_TOKEN!,
      fetch,
      undefined,
      Math.max(0, 600_000 - (Date.now() - startedAt)),
    );
    const planDigest = digest({ plan, zones });
    let result: BootstrapResult;
    if (verify) {
      const saved = JSON.parse(await readFile(`${folder}/result.json`, 'utf8')) as {
        planDigest: string;
        result: BootstrapResult;
      };
      if (saved.planDigest !== planDigest)
        throw new Error('Verification result belongs to another plan');
      result = saved.result;
    } else {
      const journal = await openJournal(
        `${folder}/journal.json`,
        planDigest,
        operator.actingSubject,
      );
      result = await executeBootstrap({
        root,
        plan,
        zones,
        api,
        journal,
        operator: bootstrapOperator,
      });
      await writeFile(
        `${folder}/result.json`,
        `${JSON.stringify({ planDigest, result }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    await verifyBootstrap(api, result, zones, bootstrapOperator);
    await verifyProductionOpening(production, values['--env'], verifyPlatformGovernance);
    console.log(
      JSON.stringify(
        {
          result: 'verified',
          counts: result.counts,
          sources: result.sources.map((source) => ({
            id: source.id,
            version: source.version,
            works: source.works.length,
          })),
          outcome: result.outcome,
          evidence: `${folder}/result.json`,
        },
        null,
        2,
      ),
    );
  } finally {
    await unlock();
  }
}

if (import.meta.main) await run(process.argv.slice(2));
