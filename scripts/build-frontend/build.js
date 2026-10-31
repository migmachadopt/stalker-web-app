// ═══════════════════════════════════════════════════════════════════════════════
// 🛠️ Frontend build - The pages' JSX compiled once, at deploy time
// ═══════════════════════════════════════════════════════════════════════════════
//
// The pages are written with <script type="text/babel">, which Babel compiles
// in the browser each time a page opens: a 3 MB download and seconds of work
// on a phone, and much more on a TV box. Here each such script is compiled to
// plain JavaScript in the page itself, and Babel is no longer loaded.
//
//   node build.js <frontend folder>          compiles the pages in place
//   node build.js <frontend folder> --check  only tells whether they compile
//
// Nothing is written if any page fails to compile.

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const BABEL_SCRIPT = /[ \t]*<script src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"><\/script>\n?/;
const JSX_SCRIPT = /<script type="text\/babel">([\s\S]*?)<\/script>/g;

const folder = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!folder) {
  console.error('Usage: node build.js <frontend folder> [--check]');
  process.exit(1);
}

const pages = fs.readdirSync(folder).filter(name => name.endsWith('.html'));
const built = [];

for (const name of pages) {
  const file = path.join(folder, name);
  const html = fs.readFileSync(file, 'utf8');
  if (!JSX_SCRIPT.test(html)) continue;
  JSX_SCRIPT.lastIndex = 0;

  let output;
  try {
    output = html.replace(JSX_SCRIPT, (_, source) => {
      const { code } = babel.transformSync(source, {
        presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
        sourceType: 'script',
        babelrc: false,
        configFile: false,
        comments: false,
        compact: false,
        filename: name
      });
      return `<script>\n${code}\n</script>`;
    }).replace(BABEL_SCRIPT, '');
  } catch (error) {
    console.error(`❌ ${name}: ${error.message}`);
    process.exit(1);
  }

  built.push({ name, file, output, before: html.length });
}

for (const page of built) {
  if (!checkOnly) fs.writeFileSync(page.file, page.output);
  console.log(`✅ ${page.name}: ${checkOnly ? 'compiles' : 'compiled'} (${Math.round(page.before / 1024)} KB → ${Math.round(page.output.length / 1024)} KB)`);
}
