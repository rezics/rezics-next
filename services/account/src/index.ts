import { Pool } from 'pg';
import { createAccountAuth } from './auth.ts';
import { createAccountApp } from './app.ts';
import { AccessAdmissionRegistry } from '../../main/src/modules/access/admission.ts';

const baseURL = Bun.env.ACCOUNT_BASE_URL;
const secret = Bun.env.ACCOUNT_SECRET;
const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
const databaseURL = Bun.env.ACCOUNT_DATABASE_URL;
if (!baseURL || !secret || !resource || !databaseURL) {
  throw new Error('ACCOUNT_BASE_URL, ACCOUNT_SECRET, ACCOUNT_MAIN_RESOURCE and ACCOUNT_DATABASE_URL are required');
}
const port = Number(Bun.env.ACCOUNT_PORT ?? '3002');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ACCOUNT_PORT must be an integer TCP port');

const pool = new Pool({ connectionString: databaseURL });
const accessDatabaseURL = Bun.env.ACCOUNT_ACCESS_DATABASE_URL;
const accessPool = accessDatabaseURL ? new Pool({ connectionString: accessDatabaseURL }) : null;
const access = accessPool ? new AccessAdmissionRegistry(accessPool) : null;
const operatorUserIds = new Set((Bun.env.ACCOUNT_OPERATOR_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
createAccountApp(createAccountAuth({ baseURL, secret, resource, pool, operatorUserIds,
  accessDeletionFence: access ? async subject => {
    await access.strongDeactivateAccountSubject(new URL('/api/auth', baseURL).toString(), subject);
  } : undefined,
}), pool)
  .listen({ hostname: '127.0.0.1', port });
