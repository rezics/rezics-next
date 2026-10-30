import { createAccountTokenProvider, IMPORTER_SCOPES } from './credentials.ts';
import { createImportTransport } from './import-client.ts';
import { seedReviewedCatalogue } from './reviewed-catalogue.ts';

/** Deliberate operator entry point; ordinary provider CLI never invokes this writer. */
export async function runReviewedCatalogueSeedCli(argv: readonly string[]): Promise<void> {
  const required = ['--state', '--api', '--auth', '--account-key', '--account', '--client'];
  if (argv.length !== required.length * 2) throw new TypeError('Expected explicit seed operator configuration');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1]!;
    if (!required.includes(flag) || values.has(flag) || !value || value.length > 4096 || value.includes('\0'))
      throw new TypeError('Invalid seed operator configuration');
    values.set(flag, value);
  }
  const origin = (flag: string) => {
    const url = new URL(values.get(flag)!);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new TypeError('Seed API and Auth require HTTPS origins');
    return url.origin;
  };
  const api = origin('--api');
  const auth = origin('--auth');
  const tokenProvider = await createAccountTokenProvider({
    accountKeyPath: values.get('--account-key')!,
    account: values.get('--account')!,
    client: values.get('--client')!,
    authOrigin: auth,
    scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt'],
  });
  const port = createImportTransport({ origin: api, tokenProvider });
  const result = await seedReviewedCatalogue({ path: values.get('--state')!, port });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  try {
    await runReviewedCatalogueSeedCli(Bun.argv.slice(2));
  } catch {
    process.stderr.write('Reviewed vocabulary seeding failed.\n');
    process.exitCode = 1;
  }
}
