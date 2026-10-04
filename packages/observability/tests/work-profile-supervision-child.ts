import { writeFileSync } from 'node:fs';

writeFileSync(process.env.WORK_PROFILE_PID_FILE!, String(process.pid));
process.on('SIGTERM', () => {});
await Bun.sleep(60_000);
