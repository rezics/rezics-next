import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Routes = MainApp['~Routes']['v1'];
type Scalar = Routes['works'][':id']['scalar-value']['post']['response'];
export type ScalarConflictCodes = Assert<Equal<Scalar[409]['code'],
  'stale_head' | 'idempotency_conflict' | 'admission_busy' | 'controller_continuity'>>;
export type PreferenceConflictCode = Assert<Equal<Routes['me']['acting-context-preferences']['work.create']['put']['response'][409]['code'], 'stale_context'>>;
export type PublicReadMissingCode = Assert<Equal<Routes['works'][':id']['get']['response'][404]['code'], 'work_unavailable'>>;

const client = treaty<MainApp>('http://main.invalid');
type ScalarError = NonNullable<Awaited<ReturnType<ReturnType<typeof client.v1.works>['scalar-value']['post']>>['error']>;
export type EdenConflictCodes = Assert<Equal<Extract<ScalarError, { status: 409 }>['value']['code'], Scalar[409]['code']>>;

export async function discriminatePilot() {
  const result = await client.v1.works({ id: '00000000-0000-4000-8000-000000000001' })['scalar-value'].post({
    profile: 'work-scalar-state-v1', expectedHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  }, { headers: { 'Idempotency-Key': 'native-contract-proof' } });
  if (result.error?.status === 409) {
    const conflict = result.error.value;
    switch (conflict.code) {
      case 'stale_head': { const code: 'stale_head' = conflict.code; return code; }
      case 'idempotency_conflict': return conflict.code;
      case 'admission_busy': return conflict.code;
      case 'controller_continuity': return conflict.code;
      default: { const exhaustive: never = conflict; return exhaustive; }
    }
  }
  if (result.data && 'operationId' in result.data) {
    const reconciling: 'reconciling' = result.data.status;
    const retry: true = result.data.retry.allowed;
    return { reconciling, retry };
  }
  return result.data?.replayed;
}
