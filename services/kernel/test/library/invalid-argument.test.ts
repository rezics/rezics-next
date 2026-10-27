import {expect,test} from 'bun:test';
import {PROBLEMS,ProblemError} from '../../src/http/problem.ts';
test('invalid_argument is a nonretryable bad argument problem',()=>{
 expect(PROBLEMS).toHaveProperty('invalid_argument',{status:400,title:'Invalid Argument',retryable:false});
 const error=new ProblemError('invalid_argument' as keyof typeof PROBLEMS);
 expect(error.code).toBe('invalid_argument');
});
