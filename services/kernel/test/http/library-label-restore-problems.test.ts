import { expect,test } from 'bun:test';
import { Value } from 'typebox/value';
import { ProblemError,problemResponse,problemSchema } from '../../src/http/problem.ts';
test('label undo reports stable409 stale expired occupied and restore-capacity codes distinct from fresh assignment capacity',async()=>{
  for(const code of ['library_label_restore_stale','library_label_restore_expired','library_label_restore_occupied','library_label_restore_capacity'] as const){
    const response=problemResponse(new ProblemError(code),{method:'POST',id:'label-undo'});
    expect(response.status).toBe(409);
    const body=await response.json();
    expect(body.code).toBe(code);
    expect(body.status).toBe(409);
    expect(body.effect_status).toBe('not_applied');
    expect(body.retryable).toBe(false);
    expect(body.request_id).toBe('label-undo');
    expect(Value.Check(problemSchema(code),body)).toBe(true);
    for(const field of ['labelId','assignmentId','subjectId','name','stack','pin'])expect(body).not.toHaveProperty(field);
  }
});
