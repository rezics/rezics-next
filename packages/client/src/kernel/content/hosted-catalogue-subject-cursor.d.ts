import type { CursorBinding } from '../tokens/cursor.ts';
import type { ReadContext } from './model.ts';
export declare function hostedSubjectCursorBinding(subjectId: string, context: ReadContext, limit: number): CursorBinding;
