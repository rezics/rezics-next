import { Pool } from 'pg';
import { createAccountAuth } from './auth.ts';
import { activateStagedKey, PUBLICATION_SECONDS, retireSigningKey, signingKeyStatus,
  stageSigningKey } from './signing-keys.ts';

const [mode, argument] = process.argv.slice(2);
const baseURL = Bun.env.ACCOUNT_BASE_URL;
const secret = Bun.env.ACCOUNT_SECRET;
const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
const databaseURL = Bun.env.ACCOUNT_DATABASE_URL;
const published = argument === undefined ? PUBLICATION_SECONDS : Number(argument);
if (!baseURL || !secret || !resource || !databaseURL
  || !['status', 'stage', 'activate', 'retire'].includes(mode ?? '')
  || (mode === 'retire' && !argument)
  || (mode === 'activate' && (!Number.isSafeInteger(published) || published < 0))) {
  throw new Error('usage: ACCOUNT_BASE_URL=... ACCOUNT_SECRET=... ACCOUNT_MAIN_RESOURCE=... ACCOUNT_DATABASE_URL=... bun signing-keys-cli.ts status | stage | activate [minimum-published-seconds] | retire <kid>');
}

// Output never includes private key material.
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
try {
  if (mode === 'status') {
    console.log(JSON.stringify(await signingKeyStatus(pool)));
  } else if (mode === 'stage') {
    const auth = createAccountAuth({ baseURL, secret, resource, pool, operatorUserIds: new Set() });
    console.log(JSON.stringify(await stageSigningKey(pool, await auth.$context)));
  } else if (mode === 'activate') {
    console.log(JSON.stringify(await activateStagedKey(pool, published)));
  } else {
    console.log(JSON.stringify(await retireSigningKey(pool, argument!)));
  }
} finally {
  await pool.end();
}
