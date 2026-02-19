/**
 * Post-build smoke test — validates that `dist/` contains a working site.
 *
 * Checks:
 *  1. Required files exist (index.html, sw.js, manifest.json, JS/CSS assets)
 *  2. index.html contains expected markers (app root, module script, CSP header)
 *  3. manifest.json is valid JSON with required PWA fields
 *  4. sw.js contains cache logic
 *  5. At least one JS asset was emitted
 *
 * Exit code 0 = all passed, 1 = failure.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

let failures = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// 1. dist/ exists
// ---------------------------------------------------------------------------
console.log('Checking dist/ directory...');
check('dist/ exists', existsSync(dist));
if (!existsSync(dist)) {
  console.error('\nFATAL: dist/ does not exist. Did you run `npm run build`?');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Required files
// ---------------------------------------------------------------------------
console.log('Checking required files...');
const requiredFiles = ['index.html', 'sw.js', 'manifest.json'];
for (const file of requiredFiles) {
  check(file, existsSync(join(dist, file)));
}

// ---------------------------------------------------------------------------
// 3. JS + CSS assets emitted
// ---------------------------------------------------------------------------
console.log('Checking assets...');
const assetsDir = join(dist, 'assets');
const hasAssets = existsSync(assetsDir);
check('assets/ directory exists', hasAssets);

if (hasAssets) {
  const assets = readdirSync(assetsDir);
  check('at least one .js asset', assets.some(f => f.endsWith('.js')));
  check('at least one .css asset', assets.some(f => f.endsWith('.css')));
}

// ---------------------------------------------------------------------------
// 4. index.html content
// ---------------------------------------------------------------------------
console.log('Checking index.html content...');
if (existsSync(join(dist, 'index.html'))) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  check('contains <div id="app">', html.includes('id="app"'));
  check('contains <script', html.includes('<script'));
  check('contains Content-Security-Policy', html.includes('Content-Security-Policy'));
  check('contains <title>', html.includes('<title>'));
}

// ---------------------------------------------------------------------------
// 5. manifest.json is valid
// ---------------------------------------------------------------------------
console.log('Checking manifest.json...');
if (existsSync(join(dist, 'manifest.json'))) {
  try {
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
    check('has "name"', typeof manifest.name === 'string' && manifest.name.length > 0);
    check('has "start_url"', typeof manifest.start_url === 'string');
    check('has "display"', typeof manifest.display === 'string');
  } catch {
    check('manifest.json is valid JSON', false);
  }
}

// ---------------------------------------------------------------------------
// 6. sw.js content
// ---------------------------------------------------------------------------
console.log('Checking sw.js...');
if (existsSync(join(dist, 'sw.js'))) {
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  check('contains cache logic', sw.includes('caches') || sw.includes('CACHE_NAME'));
  check('contains fetch handler', sw.includes('fetch'));
  check('build version was injected', !sw.includes('__BUILD_VERSION__'));

  // Privacy: ensure sw.js contains no external URLs (importScripts, CDN, etc.)
  const urlPattern = /https?:\/\/[^\s'"`)]+/g;
  const foundUrls = [...sw.matchAll(urlPattern)].map(m => m[0]);
  const ownOriginPattern = /^https?:\/\/localhost[:/]/;
  const externalUrls = foundUrls.filter(u => !ownOriginPattern.test(u));
  check('no external URLs in sw.js', externalUrls.length === 0);
  if (externalUrls.length > 0) {
    console.error('    External URLs found:', externalUrls);
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s) did not pass.`);
  process.exit(1);
} else {
  console.log('All checks passed.');
}
