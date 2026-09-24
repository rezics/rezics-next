'use server';

import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serviceOrigin } from '../../features/api/origins.ts';

export type CreateState =
  | { status: 'idle'; message: '' }
  | { status: 'error'; message: string }
  | { status: 'pending'; message: string; operationId: string }
  | { status: 'created'; title: string; receipt: {
      work: string; mainVersion: string; workRevision: string; mainRevision: string;
      sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
    } };

export async function createWork(_previous: CreateState, form: FormData): Promise<CreateState> {
  const title = String(form.get('title') ?? '').trim();
  if (!title || title.length > 200) return { status: 'error', message: 'Enter a title of at most 200 characters.' };
  const jar = await cookies();
  const token = jar.get('rezics_access')?.value;
  const subject = jar.get('rezics_subject')?.value;
  if (!token || !subject) redirect('/sign-in?next=%2Fstudio');
  const main = treaty<MainApp>(serviceOrigin('MAIN_ORIGIN'));
  const response = await main.v1.works.post({ profile: 'metadata-only-v1', title,
    actingSubject: subject }, { headers: { authorization: `Bearer ${token}`,
    'idempotency-key': crypto.randomUUID() }, fetch: { cache: 'no-store' } });
  if (response.error) {
    if (response.error.status === 403) return { status: 'error', message: 'This identity is not authorized to create a Work.' };
    return { status: 'error', message: response.error.value.title ?? 'Work creation is unavailable.' };
  }
  if (!response.data) return { status: 'error', message: 'Work creation returned no result.' };
  if ('operationId' in response.data) {
    return { status: 'pending', message: 'The Work is still being reconciled. Keep your title and try again shortly.',
      operationId: response.data.operationId };
  }
  return { status: 'created', title, receipt: response.data };
}
