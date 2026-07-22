// @flash/tooling/prettier
//
// Single frozen Prettier preset shared by every workspace package.
/** @type {import('prettier').Config} */
export default {
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  printWidth: 100,
  arrowParens: 'always',
  endOfLine: 'lf',
};
