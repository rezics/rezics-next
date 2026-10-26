import { guardStatements } from './support/sql-guard.ts';

guardStatements('contexts', ['context.ts', 'http/contexts.ts', 'setup.ts', 'disclosure.ts']);
