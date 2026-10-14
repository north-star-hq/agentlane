const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['ios/', 'android/', '.expo/', 'web/test-results/', 'web/playwright-report/', 'web/.auth/'] },
  {
    files: ['api/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly', fetch: 'readonly' },
    },
  },
]);
