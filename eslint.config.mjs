import base from '@flash/tooling/eslint/base';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'prototype/**', 'load/k6/**'] },
  ...base,
];
