// prettier.config.mjs
/** @type {import("prettier").Config} */
const config = {
  // Core formatting
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  jsxSingleQuote: false,
  trailingComma: 'all',
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: 'always',
  proseWrap: 'preserve',
  htmlWhitespaceSensitivity: 'css',
  endOfLine: 'lf',
  embeddedLanguageFormatting: 'auto',

  // Keep attributes/props readable for accessibility
  jsxBracketSameLine: false,

  // Plugins:
  // - tailwindcss: sorts Tailwind classnames deterministically
  // - prisma: formats Prisma schema files
  // - packagejson: keeps package.json field order stable
  plugins: [
    'prettier-plugin-prisma',
    'prettier-plugin-packagejson',
    'prettier-plugin-tailwindcss', // MUST be last per the plugin’s docs
  ],

  // Per-file overrides
  overrides: [
    // Next.js & React
    {
      files: ['**/*.tsx', '**/*.jsx'],
      options: {
        parser: 'typescript',
      },
    },
    // Server & libs
    {
      files: ['**/*.ts', '**/*.mts', '**/*.cts'],
      options: {
        parser: 'typescript',
      },
    },
    // Markdown
    {
      files: ['**/*.md', '**/*.mdx'],
      options: {
        proseWrap: 'always',
      },
    },
    // JSON / YAML
    {
      files: ['**/*.json', '**/*.jsonc'],
      options: {
        parser: 'json',
      },
    },
    {
      files: ['**/*.yml', '**/*.yaml'],
      options: {
        singleQuote: false,
      },
    },
    // Prisma schema formatting
    {
      files: ['**/*.prisma'],
      options: {
        // plugin handles parser
      },
    },
    // MJML email templates (treat as HTML)
    {
      files: ['**/*.mjml'],
      options: {
        parser: 'html',
      },
    },
    // Helm charts & Kubernetes manifests (YAML already covered)
  ],
};

export default config;
