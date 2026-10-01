import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSeedRequest } from '../../../scripts/dev/seed/request-schema.ts';

interface IntakePort {
  actingSubject: string;
  request(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; body: unknown }>;
}
export interface CatalogueWorkInput {
  title: string;
  language: string;
  semanticTypes: string[];
}

export class CatalogueIntakeUnavailable extends Error {}

/** The search receipt is part of the creation digest. Keep client evidence,
 * including an unanswered write, across seed processes; a reset's epoch cannot
 * reuse it. These files contain no credentials or owner-store data. */
export function catalogueIntakePath(epoch: string, actor: string, key: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([epoch, actor, key]))
    .digest('hex');
  return join(import.meta.dir, '../../../.temp/catalogue-intake', `${digest}.json`);
}

export async function catalogueWorkBody(port: IntakePort, input: CatalogueWorkInput, key: string) {
  const searchBody = {
    profile: 'catalogue-candidates-v1',
    originalTitle: { value: input.title, language: input.language },
    aliases: [],
    romanizations: [],
    creators: [],
    dates: [],
    identifiers: [],
  };
  assertSeedRequest('POST', '/v1/catalogue/candidates', searchBody);
  const searched = await port.request('POST', '/v1/catalogue/candidates', searchBody);
  const result = searched.body as {
    code?: string;
    candidateReceipt?: string;
    sourcePosition?: { dataEpoch?: string };
  };
  if (searched.status === 503 && result?.code === 'catalogue_unavailable') {
    throw new CatalogueIntakeUnavailable('Catalogue intake is unavailable');
  }
  if (searched.status !== 200 || !result?.candidateReceipt || !result.sourcePosition?.dataEpoch) {
    throw new Error(
      `/v1/catalogue/candidates HTTP ${searched.status} ${JSON.stringify(searched.body).slice(0, 500)}`,
    );
  }
  const body = {
    profile: 'metadata-only-v1' as const,
    ...input,
    actingSubject: port.actingSubject,
    grain: 'new-creative-scope' as const,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const path = catalogueIntakePath(result.sourcePosition.dataEpoch, port.actingSubject, key);
  mkdirSync(join(import.meta.dir, '../../../.temp/catalogue-intake'), { recursive: true });
  try {
    writeFileSync(
      path,
      JSON.stringify({ fingerprint, candidateReceipt: result.candidateReceipt }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const retained = JSON.parse(readFileSync(path, 'utf8')) as {
    fingerprint: string;
    candidateReceipt: string;
  };
  if (retained.fingerprint !== fingerprint)
    throw new Error(`Catalogue fixture intent changed for ${key}`);
  const requestBody = { ...body, candidateReceipt: retained.candidateReceipt };
  assertSeedRequest('POST', '/v1/works', requestBody);
  return requestBody;
}
