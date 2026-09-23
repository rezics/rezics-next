import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDeletionRecoverySet, captureDeletionRecoverySet,
  type DeletionRecoverySet } from './deletion-recovery-set.ts';

const mode = process.argv[2];
const accountUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const accessUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
if (!accountUrl || !accessUrl
  || (mode !== 'capture' && mode !== 'verify')
  || (mode === 'capture' && (!process.argv[3] || !process.argv[4]))
  || (mode === 'verify' && !process.argv[3])) {
  throw new Error('usage: ACCOUNT_RECOVERY_DATABASE_URL=... ACCESS_RECOVERY_DATABASE_URL=... bun deletion-recovery-set-cli.ts capture <issuer> <account-subject> | verify <set.json>');
}

const account = new Pool({ connectionString: accountUrl });
const access = new Pool({ connectionString: accessUrl });
try {
  if (mode === 'capture') {
    console.log(JSON.stringify(await captureDeletionRecoverySet(
      account, access, process.argv[3]!, process.argv[4]!)));
  } else {
    const expected = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as DeletionRecoverySet;
    await assertDeletionRecoverySet(account, access, expected);
    console.log('Account and Access deletion recovery set matches both restored owners');
  }
} finally {
  await Promise.all([account.end(), access.end()]);
}
