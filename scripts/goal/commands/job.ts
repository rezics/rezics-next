import { jobRuntime } from '../job.ts';
import { pathToFileURL } from 'node:url';

export const usage = 'Usage: goalctl job -- <command…>';
export default async function job(command: string[]): Promise<number> {
  const { runJob } = await import(pathToFileURL(jobRuntime(process.cwd())).href) as typeof import('../job.ts');
  return runJob(command);
}
