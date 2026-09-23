import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDeletionRecoverySet, captureDeletionRecoverySet,
  type DeletionRecoverySet } from './deletion-recovery-set.ts';
import { openRecoveryPayload, sealRecoveryPayload } from './recovery-envelope.ts';

const mode = process.argv[2];
const accountUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const accessUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
if (!accountUrl || !accessUrl || !key
  || (mode !== 'capture' && mode !== 'verify')
  || (mode === 'capture' && (!process.argv[3] || !process.argv[4]))
  || (mode === 'verify' && !process.argv[3])) {
  throw new Error('usage: ACCOUNT_RECOVERY_DATABASE_URL=... ACCESS_RECOVERY_DATABASE_URL=... RECOVERY_MANIFEST_HMAC_KEY=<64 hex characters> bun deletion-recovery-set-cli.ts capture <issuer> <account-subject> | verify <set.json>');
}

const account = new Pool({ connectionString: accountUrl });
const access = new Pool({ connectionString: accessUrl });
try {
  if (mode === 'capture') {
    console.log(JSON.stringify(sealRecoveryPayload(await captureDeletionRecoverySet(
      account, access, process.argv[3]!, process.argv[4]!), key, 'deletion-recovery-set')));
  } else {
    const expected = openRecoveryPayload<DeletionRecoverySet>(
      readFileSync(process.argv[3]!, 'utf8'), key, 'deletion-recovery-set');
    await assertDeletionRecoverySet(account, access, expected);
    console.log('Account and Access deletion recovery set matches both restored owners');
  }
} finally {
  await Promise.all([account.end(), access.end()]);
}
