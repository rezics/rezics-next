import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workAddressLifecycleDeclaration = {
  id: 'work-address-lifecycle-v1',
  canonical: {
    redirect: {
      types: ['<https://rezics.com/vocab/RouteBinding>'],
      when: [{
        path: '<https://rezics.com/vocab/routeState>',
        value: '<https://rezics.com/vocab/Redirected>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;
