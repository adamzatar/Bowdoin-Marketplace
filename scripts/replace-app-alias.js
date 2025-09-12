#!/usr/bin/env node
// replace-app-alias.js
// Rewrites "@/..." and "@/src/..." imports in apps/web to correct relative paths.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const APP_ROOT = path.join(ROOT, 'apps', 'web');

// maps prefix "@/something" -> real folder on disk
// We treat "@/src/*" as APP_ROOT/src/* and "@/*" as APP_ROOT/*
const ALIASES = [
  { prefix: '@/src/', target: path.join(APP_ROOT, 'src') + '/' },
  { prefix: '@/',     target: APP_ROOT + '/' },
];

function rewriteSpecifier(fromFile, spec) {
  for (const { prefix, target } of ALIASES) {
    if (spec.startsWith(prefix)) {
      const absTarget = path.join(target, spec.slice(prefix.length));
      const rel = path.relative(path.dirname(fromFile), absTarget);
      let fixed = rel.replace(/\\/g, '/');
      if (!fixed.startsWith('.')) fixed = './' + fixed;
      return fixed;
    }
  }
  return null;
}

function processFile(fp) {
  const src = fs.readFileSync(fp, 'utf8');
  const out = src.replace(
    /((?:import|export)\s+(?:[^'"]+?\s+from\s+)?)(['"])([^'"]+)\2/g,
    (m, head, quote, spec) => {
      const replacement = rewriteSpecifier(fp, spec);
      return replacement ? `${head}${quote}${replacement}${quote}` : m;
    }
  );
  if (out !== src) {
    fs.writeFileSync(fp, out);
    console.log('rewrote', path.relative(ROOT, fp));
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(fp);
    } else if (/\.(mts|cts|ts|tsx|js|jsx)$/.test(entry.name)) {
      processFile(fp);
    }
  }
}

walk(APP_ROOT);