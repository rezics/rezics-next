import type { CreateImportApiDriver } from '../../../../specs/imports-api-driver.ts';
import { openImportApiFixture } from './api-fixture.ts';

export const createImportApiDriver: CreateImportApiDriver = (options) => openImportApiFixture(options);
