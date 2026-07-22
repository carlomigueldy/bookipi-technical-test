// @flash/tooling/eslint/nest
//
// Backend (NestJS + Fastify, CommonJS, experimentalDecorators) preset.
// Relaxes a couple of typescript-eslint rules that fight idiomatic Nest
// decorator/DI patterns; everything else inherits from base.
import base from './base.js';

export default [
  ...base,
  {
    rules: {
      // Nest modules/providers/controllers are legitimately decorator-only
      // classes with no instance members.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
