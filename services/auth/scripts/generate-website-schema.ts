import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { Pool } from 'pg';
import { testDatabase } from './database.ts';
import { betterAuthOptions } from '../src/better-auth.ts';
import { websiteProvider } from '../src/website-provider.ts';
const fixture=testDatabase();
const database=new Pool({connectionString:fixture.url});
try {
 const base=betterAuthOptions(database,'https://auth.rezics.test','test-secret-only-at-least-32-characters');
 const options={...base, plugins:[...base.plugins,jwt(),websiteProvider('https://auth.rezics.test','https://api.rezics.test',['openid','offline_access','media:complete'])]};
 const plan=await getMigrations(options);
 await Bun.write('.temp/goal/accounts/native-migration.sql',await plan.compileMigrations());
} finally {await database.end();fixture.close();}
