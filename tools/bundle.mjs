// Bundle the game into single self-contained HTML files. No dependencies.
//   node tools/bundle.mjs
// writes  dist/foothold.html   a complete page you can open by double-clicking
//         dist/artifact.html   the same page as a fragment, for publishing as a Claude Artifact
//
// How: each ES module becomes a function that returns its exports. That only
// works because the source sticks to two simple forms, which this script checks:
//   import { a, b } from './relative.js';
//   export function f / export const c
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const order = [], seen = new Set(), code = {};

function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let src = readFileSync(file, 'utf8');
  const names = [];
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (m, list, spec) => {
    const dep = resolve(dirname(file), spec);
    visit(dep);
    return `const {${list}} = __mod[${JSON.stringify(relative(root, dep))}];`;
  });
  src = src.replace(/^export\s+(function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (m, kw, name) => { names.push(name); return `${kw} ${name}`; });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`${relative(root, file)}: unsupported import/export form`);
  code[file] = `__mod[${JSON.stringify(relative(root, file))}] = (function () {\n${src}\nreturn { ${names.join(', ')} };\n})();`;
  order.push(file);
}
visit(join(root, 'src/main.js'));

const js = `(function () {\n'use strict';\nconst __mod = {};\n${order.map((f) => code[f]).join('\n\n')}\n})();`;
const css = readFileSync(join(root, 'style.css'), 'utf8');
const page = readFileSync(join(root, 'index.html'), 'utf8');
const title = page.match(/<title>(.*?)<\/title>/)[1];
const fonts = page.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/)[0];
const body = '<div id="app"></div>';
const inner = `<title>${title}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>\n${css}</style>\n${body}\n<script>\n${js.replace(/<\/script/g, '<\\/script')}\n</script>\n`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/artifact.html'), inner);
writeFileSync(join(root, 'dist/foothold.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${inner}</body>\n</html>\n`);
console.log(`bundled ${order.length} modules, ${(js.length / 1024).toFixed(0)} kB of script -> dist/foothold.html, dist/artifact.html`);
