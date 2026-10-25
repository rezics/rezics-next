import { expect, expectTypeOf, test } from 'bun:test';
import type { AuthService } from '@rezics/auth';
import type { AccountActor } from '../../../src/request/access.ts';
import {
  createNativeContentSystem,
  NativeContentSystemUnfinishedError,
  type NativeContentSystem,
} from './native-system.ts';
import type { ContentActors, ContentCredential, ContentSystem, ContentSystemOptions } from './system.ts';

test('ordinary native fixture is the exact ContentSystem subset with the same native Auth service', () => {
  expectTypeOf<NativeContentSystem>().toEqualTypeOf<
    Omit<ContentSystem, 'actors' | 'auth'> & {
      readonly actors: Omit<ContentActors, 'worker' | 'otherWorker'>;
      readonly auth: Omit<ContentSystem['auth'], 'websiteClient'>;
      readonly nativeAuth: AuthService;
    }
  >();
  expectTypeOf<typeof createNativeContentSystem>().toEqualTypeOf<
    (options: ContentSystemOptions) => Promise<NativeContentSystem>
  >();
  expectTypeOf<Omit<NativeContentSystem, 'actors' | 'auth' | 'nativeAuth'>>().toEqualTypeOf<
    Omit<ContentSystem, 'actors' | 'auth'>
  >();
  expectTypeOf<NativeContentSystem['nativeAuth']['internal']['registerClient']>().toEqualTypeOf<
    AuthService['internal']['registerClient']
  >();
});

test('ordinary actors retain account identity and scopes without website or Worker credentials', () => {
  expectTypeOf<NativeContentSystem['actors']>().toEqualTypeOf<{
    readonly anonymous: null;
    readonly author: ContentCredential;
    readonly other: ContentCredential;
    readonly moderator: ContentCredential;
    readonly suspended: ContentCredential;
  }>();
  expectTypeOf<Extract<keyof NativeContentSystem['actors'], 'worker' | 'otherWorker'>>().toEqualTypeOf<never>();
  expectTypeOf<keyof NativeContentSystem['auth']>().toEqualTypeOf<'ordinaryClient' | 'issue' | 'refresh'>();
  expectTypeOf<Extract<keyof NativeContentSystem['auth'], 'websiteClient'>>().toEqualTypeOf<never>();
  expectTypeOf<NativeContentSystem['actors']['author']['actor']>().toEqualTypeOf<AccountActor>();
  expectTypeOf<NativeContentSystem['actors']['author']['actor']['scopes']>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<NativeContentSystem['auth']['issue']>().toEqualTypeOf<
    (input: {
      readonly accountId: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly requestedBy?: string;
    }) => Promise<ContentCredential>
  >();
  expectTypeOf<NativeContentSystem['auth']['refresh']>().toEqualTypeOf<ContentSystem['auth']['refresh']>();
});

test('request, clock and transport contracts remain unchanged', () => {
  expectTypeOf<NativeContentSystem['kernel']>().toEqualTypeOf<ContentSystem['kernel']>();
  expectTypeOf<NativeContentSystem['access']>().toEqualTypeOf<ContentSystem['access']>();
  expectTypeOf<NativeContentSystem['clock']>().toEqualTypeOf<{
    setCommandTime(instant: string): Promise<void>;
    setCursorVerificationTime(instant: string): Promise<void>;
  }>();
  expectTypeOf<NativeContentSystem['transport']>().toEqualTypeOf<{
    capture(request: Request): Promise<{ readonly request: Request; readonly response: Response }>;
  }>();
});

test('unfinished construction fails closed synchronously before reading options or starting I/O', () => {
  let touched = 0;
  const unexpected = (): never => {
    touched++;
    throw new Error('The unfinished fixture must not inspect configuration');
  };
  const options = new Proxy({} as ContentSystemOptions, {
    get: unexpected,
    ownKeys: unexpected,
    getOwnPropertyDescriptor: unexpected,
    has: unexpected,
  });
  expect(() => createNativeContentSystem(options)).toThrow(NativeContentSystemUnfinishedError);
  expect(() => createNativeContentSystem(options)).toThrow('actual native composition is required');
  expect(new NativeContentSystemUnfinishedError().name).toBe('NativeContentSystemUnfinishedError');
  expect(touched).toBe(0);
});

test('the stub has no runtime dependencies or fabricated fixture exports; runtime outcomes remain unproven', async () => {
  const source = await Bun.file(new URL('./native-system.ts', import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  expect(transpiler.scanImports(source)).toEqual([]);
  expect(transpiler.scan(transpiler.transformSync(source)).exports.sort()).toEqual([
    'NativeContentSystemUnfinishedError',
    'createNativeContentSystem',
  ]);
});
