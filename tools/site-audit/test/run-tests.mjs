#!/usr/bin/env node
/**
 * Verification for the auditor.
 *
 * Serves two fixtures on loopback — one deliberately broken, one built the way
 * the report tells you to build it — runs the real audit against each, and
 * asserts the broken page trips every check while the clean page trips none of
 * the page-level ones. Run with `npm test`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures');
const auditScript = path.join(here, '..', 'audit.mjs');

const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=UTF-8',
};

/** Fixtures reference __BASE__ so absolute URLs match whatever port we get. */
async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const base = 'http://' + req.headers.host;

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': MIME['.txt'] });
      res.end('User-agent: *\nAllow: /\nSitemap: ' + base + '/sitemap.xml\n');
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': MIME['.xml'] });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        '<url><loc>' + base + '/clean.html</loc></url>' +
        '<url><loc>' + base + '/broken.html</loc></url></urlset>',
      );
      return;
    }
    if (url.pathname === '/dgr-responsive-repair.css') {
      const css = await readFile(
        path.join(here, '..', '..', '..', 'fixes', 'wordpress', 'dgr-responsive-repair.css'),
      );
      res.writeHead(200, { 'content-type': 'text/css; charset=UTF-8' });
      res.end(css);
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture index</title></head><body><a href="/clean.html">clean</a></body></html>');
      return;
    }

    const file = path.join(fixtureDir, path.basename(url.pathname));
    try {
      let body = await readFile(file);
      const ext = path.extname(file);
      if (ext === '.html') body = Buffer.from(body.toString('utf8').replaceAll('__BASE__', base));
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': MIME['.html'] });
      res.end('<!doctype html><title>Not found</title>Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function runAudit(url, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        auditScript, url,
        '--max-pages', '1',
        '--breakpoints', '320,390',
        '--no-screenshots',
        '--json-only',
        '--no-proxy',
        '--out', outDir,
      ],
      { cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      // Exit code 1 just means "critical findings present", which is expected
      // for the broken fixture; 2 is a genuine failure.
      if (code === 2) return reject(new Error('audit crashed:\n' + stderr));
      resolve({ code, stderr });
    });
  });
}

const EXPECTED_IN_BROKEN = [
  'viewport-meta-not-device-width',
  'viewport-zoom-disabled',
  'horizontal-overflow',
  'fixed-widths',
  'unconstrained-blocks',
  'tap-targets-too-small',
  'text-too-small',
  'images-not-fluid',
  'images-oversized-for-mobile',
  'images-missing-dimensions',
  'title-too-short',
  'meta-description-missing',
  'canonical-missing',
  'html-lang-missing',
  'h1-missing',
  'heading-hierarchy-skips',
  'images-missing-alt',
  'open-graph-incomplete',
  'structured-data-missing',
  'thin-content',
  'target-blank-without-noopener',
  'links-without-text',
  'meta-keywords-present',
];

// The clean fixture may still trip `low` polish checks (a standalone prose link
// shorter than 44px, for instance); anything more serious is a false positive.
const FORBIDDEN_SEVERITIES = new Set(['critical', 'high', 'medium']);

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    process.stdout.write('  ok   ' + name + '\n');
  } else {
    failures += 1;
    process.stdout.write('  FAIL ' + name + (extra ? ' — ' + extra : '') + '\n');
  }
}

async function main() {
  const { server, port } = await startServer();
  const workDir = await mkdtemp(path.join(tmpdir(), 'site-audit-test-'));
  const base = 'http://127.0.0.1:' + port;

  try {
    process.stdout.write('\nbroken fixture\n');
    const brokenOut = path.join(workDir, 'broken');
    await runAudit(base + '/broken.html', brokenOut);
    const broken = JSON.parse(await readFile(path.join(brokenOut, 'report.json'), 'utf8'));
    const brokenPage = broken.pages[0];

    check('page loaded', !brokenPage.error, brokenPage.error);
    const brokenIds = new Set((brokenPage.findings || []).map((f) => f.id));
    for (const id of EXPECTED_IN_BROKEN) {
      check('detects ' + id, brokenIds.has(id));
    }
    check(
      'reports horizontal overflow amount',
      (brokenPage.breakpoints[0].data.overflowPx || 0) > 500,
      'overflowPx=' + brokenPage.breakpoints[0].data.overflowPx,
    );
    const overflowSelectors = brokenPage.breakpoints[0].data.overflowElements
      .map((el) => el.selector);
    check(
      'names the wrapper that breaks out',
      overflowSelectors.some((sel) => sel.includes('shell')),
      JSON.stringify(overflowSelectors),
    );
    check(
      'also names the widest nested culprit',
      brokenPage.breakpoints[0].data.overflowElements.some((el) => el.tag === 'img'),
      JSON.stringify(overflowSelectors),
    );
    check('collected mobile vitals', brokenPage.cwv && brokenPage.cwv.ttfb !== null);
    check('site checks ran', Array.isArray(broken.siteFindings));
    check(
      'finds the advertised sitemap',
      broken.siteRaw.sitemap && broken.siteRaw.sitemap.entries === 2,
      JSON.stringify(broken.siteRaw.sitemap),
    );
    check(
      'does not report a soft 404',
      !broken.siteFindings.some((f) => f.id === 'soft-404'),
    );

    process.stdout.write('\nclean fixture\n');
    const cleanOut = path.join(workDir, 'clean');
    await runAudit(base + '/clean.html', cleanOut);
    const clean = JSON.parse(await readFile(path.join(cleanOut, 'report.json'), 'utf8'));
    const cleanPage = clean.pages[0];

    check('page loaded', !cleanPage.error, cleanPage.error);
    const noisy = (cleanPage.findings || []).filter((f) => FORBIDDEN_SEVERITIES.has(f.severity));
    check(
      'no false positives above low severity',
      noisy.length === 0,
      noisy.map((f) => f.id + '(' + f.severity + ')').join(', '),
    );
    for (const id of EXPECTED_IN_BROKEN) {
      const cleanIds = new Set((cleanPage.findings || []).map((f) => f.id));
      if (cleanIds.has(id)) check('clean page free of ' + id, false);
    }
    check(
      'no horizontal scroll at 320px',
      (cleanPage.breakpoints[0].data.overflowPx || 0) <= 1,
      'overflowPx=' + cleanPage.breakpoints[0].data.overflowPx,
    );
    check('counts real content', cleanPage.seo.wordCount >= 250, 'words=' + cleanPage.seo.wordCount);

    process.stdout.write('\nWordPress patch set (before/after)\n');
    const wpBeforeOut = path.join(workDir, 'wp-before');
    await runAudit(base + '/wp-broken.html', wpBeforeOut);
    const wpBefore = JSON.parse(await readFile(path.join(wpBeforeOut, 'report.json'), 'utf8'));
    const beforeIds = new Set((wpBefore.pages[0].findings || []).map((f) => f.id));

    // Defect classes the baseline patch set claims to fix without needing the
    // site-specific audit. Each must be present before and absent after.
    const PATCHED = [
      'viewport-meta-not-device-width',
      'viewport-zoom-disabled',
      'horizontal-overflow',
      'unconstrained-blocks',
      'tap-targets-too-small',
      'images-not-fluid',
      'images-missing-dimensions',
      'images-missing-alt',
      'html-lang-missing',
      'title-too-short',
      'meta-description-missing',
      'canonical-missing',
      'open-graph-incomplete',
      'structured-data-missing',
    ];
    // `text-too-small` is deliberately absent from this list. While the viewport
    // tag is broken, Chromium's text autosizing boosts the 10px footer print to
    // ~32px, so it is genuinely not too small on a phone and the check correctly
    // stays quiet. It becomes a real finding once the viewport is fixed, which
    // is why the repair stylesheet raises those classes — asserted directly below.
    for (const id of PATCHED) {
      check('before: ' + id + ' present', beforeIds.has(id));
    }
    check(
      'before: page scrolls sideways',
      wpBefore.pages[0].breakpoints[0].data.overflowPx > 1,
      'overflowPx=' + wpBefore.pages[0].breakpoints[0].data.overflowPx,
    );

    const wpAfterOut = path.join(workDir, 'wp-after');
    await runAudit(base + '/wp-repaired.html', wpAfterOut);
    const wpAfter = JSON.parse(await readFile(path.join(wpAfterOut, 'report.json'), 'utf8'));
    const afterFindings = wpAfter.pages[0].findings || [];
    const afterIds = new Set(afterFindings.map((f) => f.id));

    for (const id of PATCHED) {
      check('after: ' + id + ' cleared', !afterIds.has(id));
    }
    check(
      'after: no horizontal scroll at 320px',
      wpAfter.pages[0].breakpoints[0].data.overflowPx <= 1,
      'overflowPx=' + wpAfter.pages[0].breakpoints[0].data.overflowPx,
    );
    check(
      'after: footer print is legible',
      (wpAfter.pages[0].breakpoints[0].data.smallText || []).length === 0,
      JSON.stringify(wpAfter.pages[0].breakpoints[0].data.smallText),
    );
    const stillSerious = afterFindings.filter((f) => FORBIDDEN_SEVERITIES.has(f.severity));
    check(
      'after: nothing above low severity remains',
      stillSerious.length === 0,
      stillSerious.map((f) => f.id + '(' + f.severity + ')').join(', '),
    );

    process.stdout.write('\nmarkdown report\n');
    const mdOut = path.join(workDir, 'md');
    await runAudit(base + '/broken.html', mdOut);
    // --json-only was used above; render once more without it.
    const mdOut2 = path.join(workDir, 'md2');
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [auditScript, base + '/broken.html', '--max-pages', '1', '--breakpoints', '320',
         '--no-screenshots', '--no-proxy', '--out', mdOut2],
        { cwd: path.join(here, '..'), stdio: 'ignore' },
      );
      child.on('error', reject);
      child.on('close', (code) => (code === 2 ? reject(new Error('audit crashed')) : resolve()));
    });
    const markdown = await readFile(path.join(mdOut2, 'report.md'), 'utf8');
    check('report has a fix plan', markdown.includes('## Fix plan'));
    check('report lists critical findings', /Critical —/.test(markdown));
    check('report includes CSS fixes', markdown.includes('max-width: 100%'));
    check('report has a page appendix', markdown.includes('## Page-by-page reference'));
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }

  process.stdout.write(
    '\n' + (failures === 0 ? 'all checks passed' : failures + ' check(s) failed') + '\n',
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
