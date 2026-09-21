// Static audit: every element id the JS looks up must exist in index.html.
//
// Built after the Style/Camera-Path panels grew to dozens of controls wired
// by hand across main.js and src/ui/*. A typo'd id doesn't fail the build
// (getElementById just returns null) and often doesn't throw until the exact
// control is used - which, for a collapsed accordion section, can be a long
// time after the mistake shipped. Cheap to check statically instead.
//
// Usage: node scripts/check-dom-ids.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const problems = [];

/**
 * Strip comments before scanning. Several files quote the *original* app's
 * bugs verbatim in their header comments (`document.getElementById('canvas')`
 * returning null is literally bug B12's description) - scanning those would
 * report a missing id for an element deliberately deleted years ago.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const file of walk(join(root, 'src'))) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const rel = file.slice(root.length).replace(/\\/g, '/');

  // Both lookup shapes used in this codebase: the local `$('id')` helper and
  // direct document.getElementById('id').
  const ids = [
    ...[...source.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ];

  for (const id of new Set(ids)) {
    if (!htmlIds.has(id)) problems.push(`${rel}: no element with id="${id}"`);
  }
}

if (problems.length > 0) {
  console.error(`Missing DOM ids (${problems.length}):`);
  for (const p of problems) console.error(`  ! ${p}`);
  process.exit(1);
}

console.log(`All referenced DOM ids exist (${htmlIds.size} ids in index.html).`);
