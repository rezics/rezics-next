import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type WorkResponses = MainApp['~Routes']['v1']['works']['post']['response'];
export type RouteStatusIsLiteral = Assert<Equal<WorkResponses[409]['status'], 409>>;
export type RouteCodeIsBroad = Assert<Equal<WorkResponses[409]['code'], string>>;

const client = treaty<MainApp>('http://127.0.0.1:1');
type WorkError = NonNullable<Awaited<ReturnType<typeof client.v1.works.post>>['error']>;
export type EdenStatusIsLiteral = Assert<Equal<Extract<WorkError, { status: 409 }>['status'], 409>>;
export type EdenCodeIsBroad = Assert<Equal<Extract<WorkError, { status: 409 }>['value']['code'], string>>;
