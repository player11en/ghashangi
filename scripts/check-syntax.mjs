// Parse every source and test file, before anything tries to run them.
//
// This exists because a mangled file announces itself badly. A test file with a
// broken string literal fails partway through a suite, or worse, a batch run
// reports a low pass count that looks like resource exhaustion - both of which
// cost more to diagnose than the actual mistake deserves. The same escaping
// error was made three times while building Phase 9 and 10 before this script
// existed to catch it in a second.
//
// `npm run check` already audits unresolved references and DOM ids in src/;
// neither of those looks at test/ or scripts/ at all, so a generated or
// hand-edited test file had nothing checking it until it ran.
//
// Usage: npm run check (runs automatically), or node scripts/check-syntax.mjs

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = ['src', 'test', 'scripts'];
const EXTENSIONS = ['.js', '.mjs'];

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    // node_modules is not ours to check, and artifacts are generated output.
    if (entry === 'node_modules' || entry === 'artifacts') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const files = ROOTS.flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return []; // a root that does not exist is not an error
  }
});

const broken = [];

for (const file of files) {
  try {
    // --check parses without executing, which is the whole point: a test file
    // that opens a browser must not be run just to find out it parses.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const message = String(error.stderr ?? error.message)
      .split('\n')
      .find((line) => line.includes('Error') || line.includes('^'))
      ?.trim();
    broken.push({ file, message: message ?? 'failed to parse' });
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} file(s) do not parse:\n`);
  for (const { file, message } of broken) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}

console.log(`All ${files.length} source and test files parse.`);
