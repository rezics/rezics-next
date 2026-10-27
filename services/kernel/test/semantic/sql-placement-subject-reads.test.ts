import { guardStatements } from './support/sql-guard.ts';

guardStatements('subject reads', ['subject.ts', 'page.ts', 'graph.ts']);
