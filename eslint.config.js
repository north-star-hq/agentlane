import js from '@eslint/js';
import path from 'node:path';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  includeIgnoreFile(
    ['.gitignore', 'maestro/.gitignore'].map(file => path.join(import.meta.dirname, file)),
    { gitignoreResolution: true },
  ),
  { ignores: ['examples/', 'private/', 'tests/fixtures/signin-site/playwright/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'plugin/scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] },
      ],
    },
  },
);
