import { Pool } from 'pg';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  './modules/access/admission.ts';

const url = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const command = process.argv[2];
const generation = process.argv[3];
if (!url || (command !== 'hold' && command !== 'release')
  || (command === 'release' && !generation)) {
  throw new Error('usage: ACCESS_RECOVERY_DATABASE_URL=... bun access-capture-fence.ts hold | release <generation>');
}

const pool = new Pool({ connectionString: url });
try {
  if (command === 'hold') {
    console.log(JSON.stringify({ generation: await engageAccessRecoveryFence(pool) }));
  } else {
    await releaseAccessRecoveryFence(pool, generation!);
    console.log(JSON.stringify({ released: true }));
  }
} finally {
  await pool.end();
}
