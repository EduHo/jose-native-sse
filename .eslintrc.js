module.exports = {
  root: true,

  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },

  plugins: ['@typescript-eslint', 'react', 'react-hooks'],

  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier', // must be last — disables formatting rules that conflict with Prettier
  ],

  settings: {
    react: { version: 'detect' },
  },

  env: {
    es2022: true,
    node: true,
  },

  rules: {
    // ── TypeScript ─────────────────────────────────────────────────────────────
    // Warn rather than error — a few intentional any casts exist for
    // native module detection and optional peer-dependency loading.
    '@typescript-eslint/no-explicit-any': 'warn',

    // Unused vars: allow leading-underscore convention for intentional omissions.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // Enforce `import type` for type-only imports (smaller bundles, clearer intent).
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', disallowTypeAnnotations: false },
    ],

    // Non-null assertions are sometimes unavoidable with RN native modules.
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // Prefer nullish coalescing over || for nullable values.
    '@typescript-eslint/prefer-nullish-coalescing': 'off', // requires type info

    // Disallow empty catch blocks without a comment.
    'no-empty': ['error', { allowEmptyCatch: false }],

    // ── React ──────────────────────────────────────────────────────────────────
    // Not needed with the new JSX transform (React 17+).
    'react/react-in-jsx-scope': 'off',

    // TypeScript already enforces prop types.
    'react/prop-types': 'off',

    // ── React Hooks ────────────────────────────────────────────────────────────
    'react-hooks/rules-of-hooks': 'error',
    // Warn rather than error — the hook intentionally uses optsRef to avoid
    // closing over options (documented with eslint-disable-line comment).
    'react-hooks/exhaustive-deps': 'warn',

    // ── General quality ────────────────────────────────────────────────────────
    // Allow console.log/warn/error — the library uses them for debug mode output.
    'no-console': 'off',

    'no-debugger': 'error',

    // Disallow == in favour of ===.
    eqeqeq: ['error', 'always', { null: 'ignore' }],

    // Disallow var — use const/let.
    'no-var': 'error',

    // Prefer const where variable is never reassigned.
    'prefer-const': ['error', { destructuring: 'all' }],
  },

  overrides: [
    // Test files: relax some rules that are noisy in test code.
    {
      files: ['**/__tests__/**/*.ts', '**/__mocks__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    // JS config files: allow CommonJS require and module.exports.
    {
      files: ['*.js', '*.config.js'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
  ],

  ignorePatterns: [
    'lib/',
    'plugin/build/',
    'example-expo/',
    'node_modules/',
    'coverage/',
  ],
};
