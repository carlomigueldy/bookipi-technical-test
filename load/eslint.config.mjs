import baseConfig from '@flash/tooling/eslint/base';

export default [...baseConfig, { ignores: ['k6/**', 'results/**'] }];
