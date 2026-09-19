// Catch identifiers that are used but never imported or declared.
//
// Written because exactly this slipped through: `createPostProcessing` was
// called in viewer.js with no import for it. Rollup does not error on an
// unresolved free identifier — it assumes a global — so `npm run build`
// succeeded and produced a bundle whose very first action would have thrown
// `ReferenceError: createPostProcessing is not defined`.
//
// A real linter would catch this. This is the 60-line version that covers the
// specific shape that bit us: factory/helper calls of the form `createThing(`,
// `loadThing(`, `fooBar(` that resolve to nothing in the file and are not
// browser or JS built-ins.
//
// Usage: node scripts/check-refs.mjs

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOTS = ['src'];

/** Globals a browser module may legitimately reference. */
const GLOBALS = new Set([
  'console', 'document', 'window', 'navigator', 'performance', 'location',
  'localStorage', 'sessionStorage', 'fetch', 'URL', 'URLSearchParams', 'Blob',
  'File', 'FileReader', 'Image', 'Audio', 'FormData', 'Headers', 'Request',
  'Response', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'MediaRecorder',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'Infinity', 'NaN', 'undefined', 'globalThis',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'TextDecoder', 'TextEncoder', 'CSS', 'Function',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await',
  'import', 'super', 'resolve', 'reject', 'async',
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (extname(path) === '.js') yield path;
  }
}

const problems = [];

for (const root of ROOTS) {
  for await (const path of walk(root)) {
    const source = await readFile(path, 'utf8');

    // Strip comments and strings so their contents cannot look like code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    // Everything this file brings into scope.
    const declared = new Set();
    for (const m of code.matchAll(/import\s+(?:\*\s+as\s+(\w+)|(\w+))?\s*,?\s*(?:\{([^}]*)\})?\s*from/g)) {
      if (m[1]) declared.add(m[1]);
      if (m[2]) declared.add(m[2]);
      if (m[3]) {
        for (const spec of m[3].split(',')) {
          const name = spec.trim().split(/\s+as\s+/).pop().trim();
          if (name) declared.add(name);
        }
      }
    }
    for (const m of code.matchAll(/\b(?:function|class)\s+(\w+)/g)) declared.add(m[1]);
    for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)/g)) declared.add(m[1]);

    // Method shorthand in object literals and classes — `setAmbient(v) { … }`,
    // `get materials() { … }`, `async setAO(on) { … }`. These are definitions,
    // not calls, but they look identical to a call at the character level, so
    // without this every method in every returned object is a false positive.
    // `(?:get|set)` needs the trailing space, or the alternation eats the
    // prefix of names like `setAO` and declares `AO` instead.
    for (const m of code.matchAll(/(?:^|[\s,{;])(?:async\s+)?(?:(?:get|set)\s+)?(\w+)\s*\([^()]*\)\s*\{/gm)) {
      declared.add(m[1]);
    }

    // Default-valued parameters holding functions, e.g. `onTick = () => {}` in
    // a destructured options object. The parameter-list scan below cannot see
    // these because it does not handle nested braces.
    for (const m of code.matchAll(/(\w+)\s*=\s*(?:\([^)]*\)\s*=>|function\b|\w+\s*=>)/g)) {
      declared.add(m[1]);
    }
    // Destructured bindings and parameters, conservatively.
    for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const spec of m[1].split(',')) {
        const name = spec.trim().split(/[:=]/).pop().trim();
        if (/^\w+$/.test(name)) declared.add(name);
      }
    }
    for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
      for (const spec of m[1].split(',')) {
        const name = spec.trim().split(/[:=]/)[0].replace(/[{}.\s]/g, '').trim();
        if (/^\w+$/.test(name)) declared.add(name);
      }
    }

    // Called identifiers that look like module-level helpers.
    for (const m of code.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]{2,})\s*\(/g)) {
      const name = m[1];
      if (GLOBALS.has(name) || declared.has(name)) continue;
      problems.push(`${path}: calls ${name}() with no import or declaration`);
    }
  }
}

const unique = [...new Set(problems)];
if (unique.length > 0) {
  console.log(`${unique.length} unresolved reference(s):`);
  for (const p of unique) console.log(`  x ${p}`);
  process.exit(1);
}
console.log('No unresolved references.');
