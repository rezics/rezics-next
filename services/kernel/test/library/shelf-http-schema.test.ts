import {expect,test} from 'bun:test';
import {Value} from 'typebox/value';
import {shelfListQuerySchema} from '../../src/library/shelf-schemas.ts';
test('shelf wire types preserve full CURIE filters and reject unknown predicates',()=>{
 const query={orderBy:'lastActivity',direction:'desc',type:'schema:'+ 'A'.repeat(8192),limit:48};
 expect(Value.Check(shelfListQuerySchema,query)).toBe(true);
 expect(Value.Check(shelfListQuerySchema,{...query,typeKey:'uuid'})).toBe(false);
 expect(Value.Check(shelfListQuerySchema,{...query,orderBy:'random'})).toBe(false);
 expect(Value.Check(shelfListQuerySchema,{...query,limit:101})).toBe(false);
});
