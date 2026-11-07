import { expect, test } from 'bun:test';
import type { Access } from '../../src/access/index.ts';
import type { Pool } from 'pg';
import { createSourceBindingApplication } from '../../src/semantic/source-binding-application.ts';
import type {
  PublicFilterSource,
  PublicFilterSourceBootstrapBinding,
  PublicFilterSourceDefinition,
} from '../../src/semantic/index.ts';
import type {
  PublicFilterAccessBindingPort,
  PublicFilterSearchBindingPort,
  SourceBindingApplicationPorts,
} from '../../src/semantic/source-binding-port.ts';

test('Source creation, binding and repair use the same native/Search/Access application', async () => {
  const pool = {} as Pool;
  const access = {} as Access;
  const routeKey = new Uint8Array([7, 3, 1]);
  const config = { pool, routeKey, access, clock: () => new Date(0) };
  const source = {} as PublicFilterSource;
  const binding = {} as PublicFilterSourceBootstrapBinding;
  const search = {} as PublicFilterSearchBindingPort;
  const accessPort = {} as PublicFilterAccessBindingPort;
  let supplied: Parameters<SourceBindingApplicationPorts['native']['createBinding']>[3] | undefined;
  const definitionResult = { definition: {} as PublicFilterSourceDefinition, bytes: 7 };
  let definitionReads = 0;
  let sourceCalls = 0;
  const native: SourceBindingApplicationPorts['native'] = {
    createBinding(receivedPool, receivedRouteKey, receivedAccess, nativePorts) {
      expect(receivedPool).toBe(pool);
      expect(receivedRouteKey).toBe(routeKey);
      expect(receivedAccess).toBe(access);
      supplied = nativePorts;
      return binding;
    },
    readDefinition(id, receivedPool, routeDigest, receivedSearch, maxBytes) {
      expect(id).toBe('definition');
      expect(receivedPool).toBe(pool);
      expect(routeDigest).toBe('route-digest');
      expect(receivedSearch).toBe(search);
      expect(maxBytes).toBe(7);
      definitionReads++;
      return Promise.resolve(definitionResult);
    },
    createSource(receivedConfig, receivedBindingFactory, receivedSearch, receivedAccessPort) {
      expect(receivedConfig.pool).toBe(pool);
      expect(receivedBindingFactory).toBeTypeOf('function');
      expect(receivedSearch).toBe(search);
      expect(receivedAccessPort).toBe(accessPort);
      sourceCalls++;
      return source;
    },
  };
  const ports = {
    native,
    search,
    access: accessPort,
  } as unknown as SourceBindingApplicationPorts;
  const application = createSourceBindingApplication(ports);

  expect(application.createSource(config)).toBe(source);
  expect(await application.readDefinition('definition', pool, 'route-digest', 7)).toBe(definitionResult);
  expect(definitionReads).toBe(1);
  const origin = application.sourceOrigin(source)!;
  expect(origin).toEqual({ ...config, routeKey: new Uint8Array(routeKey) });
  expect(origin.routeKey).not.toBe(routeKey);
  routeKey[0] = 0;
  expect(origin.routeKey).toEqual(new Uint8Array([7, 3, 1]));
  routeKey[0] = 7;
  expect(application.createBinding(pool, routeKey, access)).toBe(binding);
  expect(supplied?.search).toBe(search);
  expect(supplied?.access).toBe(accessPort);

  const retainedSource = supplied?.sourceFactory(config);
  expect(retainedSource).toBe(source);
  expect(supplied?.sourceOrigin(retainedSource!)).toEqual({ ...config, routeKey: new Uint8Array(routeKey) });
  expect(sourceCalls).toBe(2);
});
