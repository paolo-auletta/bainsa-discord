import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['dist/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
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
      'no-unsafe-negation': 'error',
    },
  },
]);
