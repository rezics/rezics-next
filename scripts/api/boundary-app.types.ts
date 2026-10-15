import type { MainApp } from '@rezics/main/app';

type Assert<T extends true> = T;
type WorkResponses = MainApp['~Routes']['v1']['works']['post']['response'];
export type AppStatusIsLiteral = Assert<WorkResponses[409]['status'] extends 409 ? true : false>;
export type AppCodeIsBroad = Assert<string extends WorkResponses[409]['code'] ? true : false>;
