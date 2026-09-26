/**
 * Site-level checks that live outside the rendered DOM: robots.txt, sitemaps,
 * host canonicalisation, 404 handling and response headers.
 *
 * Everything here goes through Playwright's APIRequestContext so it shares the
 * browser's proxy and TLS configuration.
 */

const SITEMAP_CANDIDATES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/wp-sitemap.xml',
  '/sitemap-index.xml',
];

async function head(request, url) {
  try {
    const response = await request.get(url, { maxRedirects: 0, timeout: 20000 });
    return {
      url,
      status: response.status(),
      location: response.headers().location || null,
      headers: response.headers(),
      ok: response.ok(),
    };
  } catch (err) {
    return { url, error: err.message };
  }
}

/** Follow redirects one hop at a time so the whole chain is visible. */
async function followChain(request, startUrl, maxHops = 6) {
  const chain = [];
  let current = startUrl;
  for (let hop = 0; hop < maxHops; hop++) {
    const step = await head(request, current);
    chain.push(step);
    if (step.error) break;
    if (step.status >= 300 && step.status < 400 && step.location) {
      current = new URL(step.location, current).href;
      continue;
    }
    break;
  }
  return chain;
}

export async function runSiteChecks(request, startUrl) {
  const parsedStart = new URL(startUrl);
  const origin = parsedStart.origin;
  const host = parsedStart.hostname;
  // Keep any explicit port so canonicalisation checks work against a dev server.
  const port = parsedStart.port ? ':' + parsedStart.port : '';
  const bareHost = host.replace(/^www\./, '');
  const altHost = host.startsWith('www.') ? bareHost : 'www.' + bareHost;

  const results = { origin, host, findings: [], raw: {} };
  const add = (f) => results.findings.push({ area: 'site', scope: 'site', ...f });

  // ------------------------------------------------------------- robots.txt
  const robotsUrl = origin + '/robots.txt';
  let robotsBody = '';
  try {
    const response = await request.get(robotsUrl, { timeout: 20000 });
    results.raw.robots = { status: response.status() };
    if (response.ok()) {
      robotsBody = await response.text();
      results.raw.robots.body = robotsBody.slice(0, 4000);
    }
    if (response.status() === 404) {
      add({
        id: 'robots-missing',
        severity: 'low',
        title: 'No robots.txt',
        detail: 'Crawlers cope without one, but it is also where the sitemap is ' +
          'advertised and where crawl budget is protected on a CMS.',
        evidence: [robotsUrl + ' returned 404'],
        fix: 'Add a robots.txt with `User-agent: *`, an `Allow: /`, and a `Sitemap:` line.',
      });
    }
  } catch (err) {
    results.raw.robots = { error: err.message };
  }

  const blocksEverything = /^\s*User-agent:\s*\*\s*$[\s\S]*?^\s*Disallow:\s*\/\s*$/im.test(robotsBody);
  if (blocksEverything) {
    add({
      id: 'robots-blocks-site',
      severity: 'critical',
      title: 'robots.txt blocks the whole site',
      detail: 'A `Disallow: /` under `User-agent: *` tells every crawler to stay out. ' +
        'This is the classic leftover from a staging environment and it removes the ' +
        'site from search entirely.',
      evidence: [robotsBody.slice(0, 200)],
      fix: 'Remove the blanket `Disallow: /`. On WordPress also untick ' +
        'Settings → Reading → "Discourage search engines from indexing this site".',
    });
  }

  const sitemapDirectives = [...robotsBody.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (robotsBody && !sitemapDirectives.length) {
    add({
      id: 'robots-no-sitemap-directive',
      severity: 'low',
      title: 'robots.txt does not advertise a sitemap',
      detail: 'The Sitemap directive is the cheapest way to make sure every crawler ' +
        'finds the full URL list.',
      evidence: ['no "Sitemap:" line in robots.txt'],
      fix: 'Append `Sitemap: ' + origin + '/sitemap.xml` to robots.txt.',
    });
  }

  // ---------------------------------------------------------------- sitemap
  const sitemapUrls = [...new Set([...sitemapDirectives, ...SITEMAP_CANDIDATES.map((p) => origin + p)])];
  let sitemapFound = null;
  for (const url of sitemapUrls) {
    try {
      const response = await request.get(url, { timeout: 20000 });
      if (!response.ok()) continue;
      const body = await response.text();
      if (!/<(urlset|sitemapindex)/i.test(body)) continue;
      const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      sitemapFound = { url, isIndex: /<sitemapindex/i.test(body), entries: locs.length, sample: locs.slice(0, 5) };
      break;
    } catch { /* try the next candidate */ }
  }
  results.raw.sitemap = sitemapFound;

  if (!sitemapFound) {
    add({
      id: 'sitemap-missing',
      severity: 'medium',
      title: 'No XML sitemap found',
      detail: 'Checked ' + sitemapUrls.length + ' locations. A sitemap is how a ' +
        'crawler discovers pages that are not well linked, and how you see indexing ' +
        'coverage in Search Console.',
      evidence: sitemapUrls.slice(0, 5),
      fix: 'Publish /sitemap.xml (Yoast, Rank Math and WordPress core all generate ' +
        'one), reference it from robots.txt, and submit it in Google Search Console.',
    });
  } else if (sitemapFound.entries === 0) {
    add({
      id: 'sitemap-empty',
      severity: 'medium',
      title: 'Sitemap contains no URLs',
      detail: 'An empty sitemap is worse than none: it tells Google the site has ' +
        'nothing to index.',
      evidence: [sitemapFound.url],
      fix: 'Regenerate the sitemap and confirm published pages appear in it.',
    });
  }

  // ------------------------------------------------- host canonicalisation
  const chains = {};
  for (const candidate of [
    'http://' + bareHost + port + '/',
    'https://' + bareHost + port + '/',
    'https://' + altHost + port + '/',
  ]) {
    chains[candidate] = await followChain(request, candidate);
  }
  results.raw.chains = chains;

  const finalOf = (chain) => {
    const last = chain[chain.length - 1];
    return last && !last.error ? last.url : null;
  };

  const httpChain = chains['http://' + bareHost + port + '/'];
  const httpFinal = finalOf(httpChain);
  if (httpFinal && httpFinal.startsWith('http://')) {
    add({
      id: 'no-https-redirect',
      severity: 'high',
      title: 'Plain HTTP is served without redirecting to HTTPS',
      detail: 'Browsers mark the page "Not secure", HTTPS is a ranking signal, and ' +
        'the http and https copies compete as duplicates.',
      evidence: httpChain.map((s) => s.status + ' ' + s.url),
      fix: 'Force a 301 from http:// to https:// at the server or CDN, then enable HSTS.',
    });
  }

  const primaryFinal = finalOf(chains['https://' + bareHost + port + '/']);
  const altFinal = finalOf(chains['https://' + altHost + port + '/']);
  const altStatus = chains['https://' + altHost + port + '/'].slice(-1)[0];
  if (primaryFinal && altFinal && hostOf(primaryFinal) !== hostOf(altFinal) &&
      altStatus && altStatus.status === 200) {
    add({
      id: 'www-not-canonicalised',
      severity: 'high',
      title: 'Both www and non-www serve the site',
      detail: 'Two hostnames returning 200 for the same content is duplicate ' +
        'content: links and ranking signals split between them.',
      evidence: [
        'https://' + bareHost + port + '/ → ' + primaryFinal,
        'https://' + altHost + port + '/ → ' + altFinal,
      ],
      fix: 'Pick one hostname, 301 the other to it, and make sure canonical tags and ' +
        'the sitemap use the chosen one.',
    });
  }

  const hops = (httpChain || []).filter((s) => s.status >= 300 && s.status < 400).length;
  if (hops > 2) {
    add({
      id: 'long-redirect-chain',
      severity: 'low',
      title: 'Redirect chain is ' + hops + ' hops long',
      detail: 'Each hop costs a round trip on a mobile connection and dilutes link equity.',
      evidence: httpChain.map((s) => s.status + ' ' + s.url),
      fix: 'Collapse the chain into a single 301 to the final URL.',
    });
  }

  // ----------------------------------------------------------- 404 handling
  const missingUrl = origin + '/this-page-should-not-exist-' + Date.now();
  const missing = await head(request, missingUrl);
  results.raw.notFound = missing;
  if (!missing.error && missing.status === 200) {
    add({
      id: 'soft-404',
      severity: 'medium',
      title: 'Missing pages return HTTP 200',
      detail: 'A "soft 404" lets an unlimited number of junk URLs look like real ' +
        'pages, which wastes crawl budget and can bloat the index.',
      evidence: [missingUrl + ' returned 200'],
      fix: 'Return a real 404 status for unknown URLs (and a 410 for content that is ' +
        'deliberately gone).',
    });
  }

  // ------------------------------------------------------- response headers
  const home = await head(request, startUrl);
  results.raw.home = home;
  if (!home.error && home.headers) {
    const h = home.headers;
    if (h['x-robots-tag'] && /noindex/i.test(h['x-robots-tag'])) {
      add({
        id: 'x-robots-noindex',
        severity: 'critical',
        title: 'X-Robots-Tag header sets noindex',
        detail: 'The server is telling crawlers not to index this page, independently ' +
          'of any meta tag.',
        evidence: ['X-Robots-Tag: ' + h['x-robots-tag']],
        fix: 'Remove the noindex directive from the server/CDN configuration.',
      });
    }
    if (!h['content-encoding']) {
      add({
        id: 'no-compression',
        severity: 'medium',
        title: 'HTML is served uncompressed',
        detail: 'No Content-Encoding header on the document response. Gzip or Brotli ' +
          'typically cuts HTML transfer by 70%, which matters most on mobile data.',
        evidence: ['no content-encoding header on ' + startUrl],
        fix: 'Enable Brotli (or gzip) for text/html, text/css, application/javascript ' +
          'and image/svg+xml.',
      });
    }
    if (!h['strict-transport-security']) {
      add({
        id: 'no-hsts',
        severity: 'low',
        title: 'No HSTS header',
        detail: 'Without Strict-Transport-Security the first request of a session can ' +
          'still be downgraded to HTTP.',
        evidence: ['strict-transport-security absent'],
        fix: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` ' +
          'once every subdomain is HTTPS-only.',
      });
    }
    const contentType = h['content-type'] || '';
    if (contentType.includes('text/html') && !/charset/i.test(contentType)) {
      add({
        id: 'no-charset-header',
        severity: 'low',
        title: 'Content-Type header declares no charset',
        detail: 'The browser has to sniff the encoding, which delays the first paint ' +
          'and occasionally mangles non-ASCII characters.',
        evidence: ['Content-Type: ' + contentType],
        fix: 'Send `Content-Type: text/html; charset=UTF-8`.',
      });
    }
  }

  return results;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}
