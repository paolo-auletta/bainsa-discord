import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    rules: {
      semi: ['error', 'always'],
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-dupe-else-if': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error'
    }
  }
]);
