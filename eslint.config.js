// eslint.config.js — root flat config (ESLint v9), production-grade for a PNPM monorepo (Next.js + TS)
// - Type-aware rules only for TS/TSX using the Project Service (multi-tsconfig support)
// - JS gets the standard JS recommended config
// - Monorepo-friendly import resolution (TS + Node), path aliases handled by resolver
// - Sensible defaults for unused vars, import ordering, and Next/Fetch handlers ergonomics

import js from "@eslint/js";
import ts from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

const IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/cdk.out/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.vercel/**"
];

export default [
  // 0) Global ignores
  { ignores: IGNORES },

  // 1) Plain JS/JSX files: use JS recommended
  {
    files: ["**/*.{js,cjs,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    ...js.configs.recommended
  },

  // 2) TypeScript (type-aware) — scoped only to TS/TSX so JS doesn't need TS services
  ...ts.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ...cfg.languageOptions,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        // ESLint v9 Project Service: auto-discovers tsconfig per workspace/package
        projectService: true,
        tsconfigRootDir: process.cwd()
      }
    },
    rules: {
      ...(cfg.rules ?? {}),
      // ergonomic defaults
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      // allow void-return handlers in JSX/onClick, etc.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } }
      ],
      // prefer typed imports/exports; TS + bundlers handle resolution
      "import/no-unresolved": "off"
    }
  })),

  // 3) Import plugin + resolver (applies to all file types)
  {
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        // resolves TS path aliases across the monorepo
        typescript: true,
        node: true
      }
    },
    rules: {
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "object", "type"],
          alphabetize: { order: "asc", caseInsensitive: true },
          "newlines-between": "always"
        }
      ]
    }
  },

  // 4) Next.js App Router: relax a couple of rules inside the web app
  {
    files: ["apps/web/**"],
    rules: {
      // server actions / route handlers often infer types; don’t force verbose returns
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  },

  // 5) Config/build/infra scripts: use lighter TS rules (no type-aware requirement)
  {
    files: [
      "**/*.config.{js,cjs,mjs,ts}",
      "infra/**",
      "scripts/**",
      "tools/**"
    ],
    // swap to non-type-checked set to avoid needing a tsconfig here
    ...ts.configs.recommended,
    rules: {
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },

  // 6) Declaration files: turn off rules that don't make sense for .d.ts
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/consistent-type-definitions": "off"
    }
  }
];