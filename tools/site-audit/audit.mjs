#!/usr/bin/env node
/**
 * Mobile-responsiveness and SEO auditor.
 *
 *   node audit.mjs https://example.com [options]
 *
 * Renders each crawled page in a real Chromium at several phone widths, walks
 * the DOM for layout and metadata defects, checks robots/sitemap/redirects at
 * the HTTP level, and writes a prioritised Markdown remediation report.
 *
 * Options:
 *   --max-pages N       pages to crawl, breadth-first (default 8)
 *   --breakpoints LIST  comma-separated widths (default 320,390,768)
 *   --out DIR           output directory (default ./audit-<host>-<timestamp>)
 *   --proxy URL         explicit proxy; otherwise HTTPS_PROXY is used
 *   --no-proxy          ignore HTTPS_PROXY entirely
 *   --timeout MS        per-navigation timeout (default 45000)
 *   --ignore-robots     crawl URLs that robots.txt disallows
 *   --no-screenshots    skip screenshot capture
 *   --json-only         write report.json but not report.md
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { probeResponsive, probeSeo, cwvInitScript, readCwv } from './lib/probes.mjs';
import { analyzeResponsive } from './lib/analyze-responsive.mjs';
import { analyzeSeo, analyzeSiteSeo } from './lib/analyze-seo.mjs';
import { runSiteChecks } from './lib/site-checks.mjs';
import { renderMarkdown, summarise } from './lib/report.mjs';

const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|7z|docx?|xlsx?|pptx?|mp[34]|avi|mov|wmv|css|js|json|xml|rss|txt)$/i;
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_[ce]id|_ga|ref|source)/i;

function parseArgs(argv) {
  const options = {
    maxPages: 8,
    breakpoints: [320, 390, 768],
    timeout: 45000,
    screenshots: true,
    jsonOnly: false,
    ignoreRobots: false,
    proxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
    out: null,
    url: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--max-pages': options.maxPages = Number(next()); break;
      case '--breakpoints':
        options.breakpoints = next().split(',').map((w) => Number(w.trim())).filter(Boolean);
        break;
      case '--out': options.out = next(); break;
      case '--proxy': options.proxy = next(); break;
      case '--no-proxy': options.proxy = null; break;
      case '--timeout': options.timeout = Number(next()); break;
      case '--ignore-robots': options.ignoreRobots = true; break;
      case '--no-screenshots': options.screenshots = false; break;
      case '--json-only': options.jsonOnly = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
        options.url = arg;
    }
  }
  return options;
}

/**
 * Playwright is usually a devDependency but is often only installed globally on
 * a CI image, so try both before giving up.
 */
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  for (const name of ['playwright', 'playwright-core']) {
    candidates.push(() => import(name));
    candidates.push(() => import(
      pathToFileURL(require.resolve(name, { paths: globalModulePaths() })).href,
    ));
  }
  for (const load of candidates) {
    let mod;
    try {
      mod = await load();
    } catch {
      continue;
    }
    // A globally installed Playwright resolves to its CommonJS entry point, and
    // Node does not always detect its named exports, so fall back to `default`.
    const api = mod.chromium ? mod : mod.default;
    if (api && api.chromium) return api;
  }
  throw new Error(
    'Playwright is not installed. Run `npm install playwright` (or ' +
    '`npm install -g playwright`) and `npx playwright install chromium`.',
  );
}

function globalModulePaths() {
  const execDir = path.dirname(process.execPath);
  return [
    path.join(execDir, '..', 'lib', 'node_modules'),
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    process.env.NODE_PATH || '',
  ].filter(Boolean);
}

function normaliseUrl(href, base) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (SKIP_EXTENSIONS.test(url.pathname)) return null;
  // Treat /path and /path/ as one page.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.href;
}

/** Minimal robots.txt matcher: the `User-agent: *` group's Disallow prefixes. */
function parseRobots(body) {
  const disallow = [];
  let inStarGroup = false;
  for (const rawLine of (body || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawField, ...rest] = line.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (field === 'user-agent') {
      inStarGroup = value === '*';
    } else if (field === 'disallow' && inStarGroup && value) {
      disallow.push(value);
    }
  }
  return {
    blocks(pathname) {
      return disallow.some((rule) => pathname.startsWith(rule.replace(/\*$/, '')));
    },
  };
}

function isLoopback(hostname) {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost');
}

function slugFor(url) {
  try {
    const { pathname } = new URL(url);
    const slug = pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return slug || 'home';
  } catch {
    return 'page';
  }
}

async function settle(page, timeout) {
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 15000) });
  } catch {
    // A site with polling or a chat widget never reaches networkidle; the load
    // event plus the grace period below is enough for the checks we run.
  }
  await page.waitForTimeout(600);
}

/** Pull the page past the fold so lazy-loaded content exists before probing. */
async function revealLazyContent(page) {
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight, 400);
    const max = Math.min(document.body ? document.body.scrollHeight : 0, 20000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 120));
  });
  await page.waitForTimeout(250);
}

async function auditPage({ context, url, options, outDir, isFirstLoad }) {
  const result = { url, breakpoints: [], screenshots: [] };
  const page = await context.newPage();
  try {
    for (const width of options.breakpoints) {
      await page.setViewportSize({ width, height: 844 });
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout,
      });
      if (response && !result.status) {
        result.status = response.status();
        result.finalUrl = response.url();
      }
      await settle(page, options.timeout);

      // Vitals are read at the primary (narrowest) breakpoint, before any
      // programmatic scrolling can contaminate the layout-shift score.
      if (!result.cwv) result.cwv = await page.evaluate(readCwv);

      await revealLazyContent(page);
      const data = await page.evaluate(probeResponsive);
      result.breakpoints.push({ name: width + 'px', width, data });

      if (!result.seo) result.seo = await page.evaluate(probeSeo);

      if (options.screenshots) {
        const file = path.join('screenshots', slugFor(url) + '-' + width + '.png');
        await page.screenshot({ path: path.join(outDir, file), fullPage: true });
        result.screenshots.push(file);
      }
    }
  } catch (err) {
    result.error = err.message.split('\n')[0];
  } finally {
    await page.close().catch(() => {});
  }

  if (!result.error && result.seo) {
    result.findings = [
      ...analyzeResponsive({ breakpoints: result.breakpoints, cwv: result.cwv }),
      ...analyzeSeo(result),
    ];
  } else {
    result.findings = [];
    if (!result.error) result.error = 'page produced no data';
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.url) {
    process.stdout.write(
      'Usage: node audit.mjs <url> [--max-pages N] [--breakpoints 320,390,768]\n' +
      '                      [--out DIR] [--proxy URL | --no-proxy] [--timeout MS]\n' +
      '                      [--ignore-robots] [--no-screenshots] [--json-only]\n',
    );
    process.exit(options.help ? 0 : 1);
  }

  const startUrl = normaliseUrl(options.url, 'https://placeholder.invalid') ||
    new URL(options.url).href;
  const host = new URL(startUrl).hostname;
  const startedAt = new Date().toISOString();
  const outDir = path.resolve(
    options.out || ('audit-' + host + '-' + startedAt.slice(0, 19).replace(/[:T]/g, '')),
  );
  await mkdir(path.join(outDir, 'screenshots'), { recursive: true });

  const { chromium, devices } = await loadPlaywright();
  // A proxy must never be applied to a loopback target: Chromium bypasses
  // loopback anyway, and Playwright's request context would not, so the
  // HTTP-level checks would fail against a local dev server.
  if (options.proxy && isLoopback(host)) {
    process.stderr.write('  ignoring proxy for loopback host ' + host + '\n');
    options.proxy = null;
  }
  const proxy = options.proxy ? { server: options.proxy } : undefined;
  const browser = await chromium.launch({ proxy });
  const phone = devices['Pixel 7'] || devices['iPhone 13'] || {};

  const context = await browser.newContext({
    ...phone,
    viewport: { width: options.breakpoints[0], height: 844 },
    // Chromium's device emulation is what makes UA-sniffing themes serve their
    // mobile variant, so the audit sees what a phone actually gets.
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: 'en-ZA',
  });
  await context.addInitScript(cwvInitScript);

  const request = context.request;
  process.stderr.write('Running site-level checks for ' + startUrl + '\n');
  let site;
  try {
    site = await runSiteChecks(request, startUrl);
  } catch (err) {
    site = { findings: [], raw: { error: err.message } };
    process.stderr.write('  site-level checks failed: ' + err.message + '\n');
  }

  let robots = { blocks: () => false };
  if (!options.ignoreRobots && site.raw && site.raw.robots && site.raw.robots.body) {
    robots = parseRobots(site.raw.robots.body);
  }

  const queue = [startUrl];
  const seen = new Set([startUrl]);
  const pages = [];

  while (queue.length && pages.length < options.maxPages) {
    const url = queue.shift();
    process.stderr.write('  [' + (pages.length + 1) + '/' + options.maxPages + '] ' + url + '\n');
    const result = await auditPage({
      context, url, options, outDir, isFirstLoad: pages.length === 0,
    });
    pages.push(result);
    if (result.error) {
      process.stderr.write('      failed: ' + result.error + '\n');
      continue;
    }

    for (const link of result.seo.links) {
      if (pages.length + queue.length >= options.maxPages * 3) break;
      const next = normaliseUrl(link.href, url);
      if (!next || seen.has(next)) continue;
      const parsed = new URL(next);
      if (parsed.hostname !== host) continue;
      if (robots.blocks(parsed.pathname)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  const siteFindings = [...site.findings, ...analyzeSiteSeo(pages)];
  const payload = {
    startUrl, startedAt, host,
    options: { ...options, proxy: options.proxy ? '(set)' : null },
    siteFindings,
    siteRaw: site.raw,
    pages,
  };

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(payload, null, 2));
  if (!options.jsonOnly) {
    const markdown = renderMarkdown({
      startUrl, startedAt, pages, siteFindings,
      breakpoints: options.breakpoints.map((w) => ({ width: w })),
      outDir,
    });
    await writeFile(path.join(outDir, 'report.md'), markdown);
  }

  await context.close();
  await browser.close();

  const all = [...siteFindings, ...pages.flatMap((p) => p.findings || [])];
  const counts = summarise(all);
  const reachable = pages.filter((p) => !p.error).length;
  process.stdout.write(
    '\n' + reachable + '/' + pages.length + ' pages audited — ' +
    counts.critical + ' critical, ' + counts.high + ' high, ' +
    counts.medium + ' medium, ' + counts.low + ' low\n' +
    'Report: ' + path.join(outDir, 'report.md') + '\n',
  );

  if (reachable === 0) {
    process.stderr.write(
      '\nNo page could be loaded. If this is a network restriction rather than a ' +
      'site fault, check that the host is reachable from this machine.\n',
    );
    process.exit(2);
  }
  process.exit(counts.critical > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write('audit failed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(2);
});
