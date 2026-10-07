import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workAddressDispositionDeclaration = {
  id: 'work-address-disposition-v1',
  canonical: {
    'retired-route': {
      types: ['<https://rezics.com/vocab/RouteBinding>'],
      when: [{
        path: '<https://rezics.com/vocab/routeState>',
        value: '<https://rezics.com/vocab/Retired>',
      }],
    },
    'merged-route': {
      types: ['<https://rezics.com/vocab/RouteBinding>'],
      when: [{
        path: '<https://rezics.com/vocab/routeState>',
        value: '<https://rezics.com/vocab/Redirected>',
      }, {
        path: '<https://rezics.com/vocab/routeDisposition>',
        value: '<https://rezics.com/vocab/Merged>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;
