// commitlint.config.mjs
// Production-grade commitlint config for a PNPM monorepo using Conventional Commits.
// - Enforces consistent types, casing, length, and blank lines
// - Provides smart, project-aware scopes (apps/*, packages/*, infra/*, etc.)
// - Keeps rules strict enough for quality, but practical for day-to-day work

import fs from "node:fs";
import path from "node:path";

/**
 * Safely list immediate subdirectories (best-effort; ignores errors).
 */
function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Derive useful scopes from the repo layout.
 * We include common meta-scopes + names from apps/*, packages/* and infra/*/charts/*.
 */
function computeScopes() {
  const root = process.cwd();

  const apps = listDirs(path.join(root, "apps"));
  const pkgs = listDirs(path.join(root, "packages"));
  const infra = listDirs(path.join(root, "infra"));
  const charts =
    infra.includes("helm")
      ? listDirs(path.join(root, "infra", "helm", "charts"))
      : [];

  // Hand-picked, repo-specific scopes that are commonly useful
  const common = [
    "repo",
    "deps",
    "infra",
    "k8s",
    "helm",
    "ci",
    "docs",
    "security",
    "observability",
    "db",
    "contracts",
    "storage",
    "queue",
    "email",
    "auth",
    "web",
    "rate-limit",
  ];

  // Normalize and dedupe
  const set = new Set([
    ...common,
    ...apps.map((a) => `app:${a}`),
    ...pkgs.map((p) => `pkg:${p}`),
    ...charts.map((c) => `chart:${c}`),
  ]);

  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Conventional types + a couple of pragmatic additions (e.g., sec).
const TYPES = [
  "feat", // a new feature
  "fix", // a bug fix
  "perf", // performance improvement
  "refactor", // code change that neither fixes a bug nor adds a feature
  "docs", // documentation only
  "style", // formatting, missing semi colons, etc; no code change
  "test", // adding or correcting tests
  "build", // changes that affect the build system or external dependencies
  "ci", // CI/CD changes
  "chore", // other changes that don’t modify src or test files
  "revert", // revert a previous commit
  "sec", // security-related change (patch, headers, policies)
  "release", // release versioning, changelog, tagging
];

const SCOPES = computeScopes();

/** @type {import('@commitlint/types').UserConfig} */
const config = {
  extends: ["@commitlint/config-conventional"],

  // Parser preset is conventional-changelog; no extra setup needed for most repos.
  // parserPreset: 'conventional-changelog-conventionalcommits',

  rules: {
    // ----- Core conventions -----
    "type-enum": [2, "always", TYPES],
    "type-case": [2, "always", "lower-case"],

    // Encourage but do not *force* a scope (warn only). Scopes are suggested from repo layout.
    "scope-enum": [1, "always", SCOPES],
    "scope-case": [2, "always", "kebab-case"],
    "scope-empty": [1, "never"],

    // Subject formatting
    "subject-case": [
      2,
      "never",
      ["sentence-case", "start-case", "pascal-case", "upper-case"],
    ],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],

    // Message structure
    "header-max-length": [2, "always", 100],
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],

    // Optional niceties
    // Allow WIP commits locally by lowering severity (comment to disable):
    // "subject-min-length": [1, "always", 5],

    // Don’t force references in every commit; keep flow practical
    // "references-empty": [0, "never"],
  },

  // Helpful prompt (used by @commitlint/prompt)
  prompt: {
    messages: {
      skip: ":skip",
      max: "upper %d chars",
      min: "at least %d chars",
      emptyWarning: "⚠️ cannot be empty",
      upperLimitWarning: "⚠️ over limit",
      lowerLimitWarning: "⚠️ below limit",
    },
    questions: {
      type: {
        description: "Select the type of change that you're committing:",
        enum: TYPES.reduce((acc, t) => {
          acc[t] = { description: t };
          return acc;
        }, {}),
      },
      scope: {
        description:
          "Specify the scope of this change (select or type your own):",
        enum: SCOPES.reduce((acc, s) => {
          acc[s] = { description: s };
          return acc;
        }, {}),
      },
      subject: {
        description:
          "Write a short, imperative description of the change (max 100 chars):",
      },
      body: {
        description:
          "Provide a longer description of the change (optional). Use '|' for new line:",
      },
      isBreaking: {
        description: "Are there any breaking changes?",
      },
      breakingBody: {
        description:
          "A BREAKING CHANGE commit requires a body. Please add a longer description:",
      },
      breaking: {
        description:
          "Describe the breaking changes. Start with imperative verb in present tense:",
      },
      isIssueAffected: {
        description: "Does this change affect any open issues?",
      },
      issues: {
        description:
          "Add issue references (e.g. 'fixes #123', 'closes #456'), separated by commas:",
      },
    },
  },
};

export default config;
