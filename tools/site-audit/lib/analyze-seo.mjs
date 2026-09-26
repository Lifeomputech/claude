/**
 * Turns the raw SEO probe output into findings.
 *
 * Per-page checks live in analyzeSeo(); anything that can only be judged by
 * comparing pages (duplicate titles, orphan pages) lives in analyzeSiteSeo().
 */

// Google renders roughly 580px of title and ~920px of description; these
// character counts are the usual practical stand-ins.
const TITLE_MIN = 20;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;
const THIN_CONTENT_WORDS = 250;

export function analyzeSeo(page) {
  const d = page.seo;
  const findings = [];
  const add = (f) => findings.push({ area: 'seo', ...f });

  // -------------------------------------------------------------------- title
  const title = (d.title || '').trim();
  if (!title) {
    add({
      id: 'title-missing',
      severity: 'critical',
      title: 'Page has no <title>',
      detail: 'The title is the single strongest on-page ranking signal and supplies ' +
        'the clickable headline in search results.',
      evidence: ['<title> is empty or absent'],
      fix: 'Write a unique 50-60 character title: "<Primary service> | <Brand>".',
    });
  } else if (title.length < TITLE_MIN) {
    add({
      id: 'title-too-short',
      severity: 'medium',
      title: 'Title is only ' + title.length + ' characters',
      detail: 'A short title wastes the most valuable space in the search result and ' +
        'usually omits the keyword the page should rank for.',
      evidence: ['"' + title + '"'],
      fix: 'Expand to 50-60 characters including the primary keyword and the brand.',
    });
  } else if (title.length > TITLE_MAX) {
    add({
      id: 'title-too-long',
      severity: 'low',
      title: 'Title is ' + title.length + ' characters and will be truncated',
      detail: 'Google cuts titles near 60 characters, so anything past that is ' +
        'invisible in the result.',
      evidence: ['"' + title + '"'],
      fix: 'Front-load the keyword and trim to 60 characters.',
    });
  }
  if (d.titleCount > 1) {
    add({
      id: 'title-duplicated-in-head',
      severity: 'medium',
      title: 'Multiple <title> tags in <head>',
      detail: 'Usually a theme and an SEO plugin both emitting one; the browser keeps ' +
        'the first and crawlers may disagree about which wins.',
      evidence: [d.titleCount + ' <title> elements'],
      fix: 'Let a single source (the SEO plugin) own the title and remove the ' +
        'theme’s hard-coded one.',
    });
  }

  // -------------------------------------------------------------- description
  const desc = (d.metaDescription || '').trim();
  if (!desc) {
    add({
      id: 'meta-description-missing',
      severity: 'high',
      title: 'No meta description',
      detail: 'Google then invents a snippet from arbitrary page text, which reads ' +
        'badly and depresses click-through. It is not a ranking factor directly, but ' +
        'CTR is.',
      evidence: ['<meta name="description"> absent'],
      fix: 'Add a 140-160 character description that states the service, the region ' +
        'served, and one reason to click.',
    });
  } else if (desc.length < DESC_MIN) {
    add({
      id: 'meta-description-thin',
      severity: 'low',
      title: 'Meta description is only ' + desc.length + ' characters',
      detail: 'Short descriptions leave result-page real estate unused.',
      evidence: ['"' + desc + '"'],
      fix: 'Expand to 140-160 characters.',
    });
  } else if (desc.length > DESC_MAX) {
    add({
      id: 'meta-description-long',
      severity: 'low',
      title: 'Meta description is ' + desc.length + ' characters and will be cut',
      detail: 'Anything past roughly 160 characters is truncated with an ellipsis.',
      evidence: ['"' + desc.slice(0, 100) + '…"'],
      fix: 'Trim to 160 characters, keeping the call to action in the first 120.',
    });
  }

  // ------------------------------------------------------------------ robots
  if (d.metaRobots && /noindex/i.test(d.metaRobots)) {
    add({
      id: 'meta-noindex',
      severity: 'critical',
      title: 'Page is set to noindex',
      detail: 'This page is explicitly excluded from search results.',
      evidence: ['<meta name="robots" content="' + d.metaRobots + '">'],
      fix: 'Remove the noindex directive unless this page is deliberately private.',
    });
  }

  // --------------------------------------------------------------- canonical
  if (!d.canonicals.length) {
    add({
      id: 'canonical-missing',
      severity: 'medium',
      title: 'No canonical URL',
      detail: 'Without a canonical, query strings, tracking parameters and http/www ' +
        'variants of this page all look like separate pages and split its ranking signals.',
      evidence: ['<link rel="canonical"> absent'],
      fix: '<link rel="canonical" href="' + page.url + '">',
    });
  } else if (d.canonicals.length > 1) {
    add({
      id: 'canonical-duplicated',
      severity: 'medium',
      title: 'Multiple canonical tags',
      detail: 'Conflicting canonicals are ignored by Google, leaving the page ' +
        'effectively uncanonicalised.',
      evidence: d.canonicals,
      fix: 'Emit exactly one canonical tag.',
    });
  } else {
    const canonical = d.canonicals[0];
    if (!sameUrl(canonical, page.url)) {
      add({
        id: 'canonical-mismatch',
        severity: 'medium',
        title: 'Canonical points somewhere else',
        detail: 'A non-self-referential canonical tells Google to index a different ' +
          'URL instead of this one. That is correct for genuine duplicates and a bug ' +
          'everywhere else.',
        evidence: ['page: ' + page.url, 'canonical: ' + canonical],
        fix: 'Point the canonical at this page’s own clean URL unless it really ' +
          'is a duplicate.',
      });
    }
  }

  // ------------------------------------------------------------------- lang
  if (!d.lang) {
    add({
      id: 'html-lang-missing',
      severity: 'medium',
      title: 'No lang attribute on <html>',
      detail: 'Screen readers pick the wrong pronunciation and search engines lose an ' +
        'explicit language/region signal.',
      evidence: ['<html> has no lang attribute'],
      fix: 'Set the language and region, e.g. `<html lang="en-ZA">` for South Africa.',
    });
  }

  // --------------------------------------------------------------- headings
  const h1s = d.headings.filter((h) => h.level === 1);
  if (!h1s.length) {
    add({
      id: 'h1-missing',
      severity: 'high',
      title: 'Page has no H1',
      detail: 'The H1 states what the page is about to both readers and crawlers. ' +
        'Pages without one routinely lose to competitors that have one.',
      evidence: d.headings.length
        ? ['first heading found is an H' + d.headings[0].level + ': "' + d.headings[0].text + '"']
        : ['no headings at all'],
      fix: 'Add exactly one H1 carrying the page’s primary keyword.',
    });
  } else if (h1s.length > 1) {
    add({
      id: 'h1-multiple',
      severity: 'low',
      title: h1s.length + ' H1 elements on the page',
      detail: 'Multiple H1s dilute the topic signal; page builders often emit one per ' +
        'section by mistake.',
      evidence: h1s.slice(0, 5).map((h) => '"' + h.text + '"'),
      fix: 'Keep one H1 and demote the rest to H2.',
    });
  }

  const skips = [];
  for (let i = 1; i < d.headings.length; i++) {
    const jump = d.headings[i].level - d.headings[i - 1].level;
    if (jump > 1) {
      skips.push(
        'H' + d.headings[i - 1].level + ' "' + d.headings[i - 1].text.slice(0, 40) +
        '" → H' + d.headings[i].level + ' "' + d.headings[i].text.slice(0, 40) + '"',
      );
    }
  }
  if (skips.length) {
    add({
      id: 'heading-hierarchy-skips',
      severity: 'low',
      title: 'Heading levels skip a rank',
      detail: 'A broken outline makes the page harder for assistive technology to ' +
        'navigate and blurs the content hierarchy for crawlers.',
      evidence: skips.slice(0, 6),
      fix: 'Step heading levels one at a time; use CSS for visual size, not heading rank.',
    });
  }

  // ----------------------------------------------------------------- images
  const missingAlt = d.images.filter((i) => !i.hasAlt && i.width > 1 && i.height > 1);
  if (missingAlt.length) {
    add({
      id: 'images-missing-alt',
      severity: 'medium',
      title: missingAlt.length + ' image(s) with no alt attribute',
      detail: 'Alt text is how screen-reader users and image search understand the ' +
        'picture. Decorative images still need an explicit empty `alt=""`.',
      evidence: missingAlt.slice(0, 8).map((i) => shortSrc(i.src)),
      fix: 'Describe the image in plain words (`alt="IATA dangerous goods training ' +
        'session in Johannesburg"`), or use `alt=""` if it is purely decorative.',
    });
  }

  // ------------------------------------------------------------ social cards
  const ogMissing = ['title', 'description', 'image', 'url']
    .filter((k) => !d.openGraph[k]);
  if (ogMissing.length) {
    add({
      id: 'open-graph-incomplete',
      severity: ogMissing.length >= 3 ? 'medium' : 'low',
      title: 'Open Graph tags missing: ' + ogMissing.join(', '),
      detail: 'Without them, links shared on LinkedIn, Facebook and WhatsApp render as ' +
        'bare URLs with no image — a real loss for a B2B site where sharing happens in chat.',
      evidence: ogMissing.map((k) => 'og:' + k + ' absent'),
      fix: [
        '```html',
        '<meta property="og:type" content="website">',
        '<meta property="og:title" content="…">',
        '<meta property="og:description" content="…">',
        '<meta property="og:url" content="' + page.url + '">',
        '<meta property="og:image" content="https://…/share-1200x630.jpg">',
        '<meta name="twitter:card" content="summary_large_image">',
        '```',
      ].join('\n'),
    });
  } else if (!d.twitter.card) {
    add({
      id: 'twitter-card-missing',
      severity: 'low',
      title: 'No twitter:card tag',
      detail: 'X/Twitter falls back to a small preview without it.',
      evidence: ['twitter:card absent'],
      fix: '<meta name="twitter:card" content="summary_large_image">',
    });
  }

  // -------------------------------------------------------- structured data
  const parsed = [];
  const broken = [];
  for (const raw of d.jsonLd) {
    try {
      parsed.push(JSON.parse(raw));
    } catch (err) {
      broken.push(err.message);
    }
  }
  if (broken.length) {
    add({
      id: 'structured-data-invalid',
      severity: 'medium',
      title: 'JSON-LD block does not parse',
      detail: 'Invalid structured data is discarded entirely, so any rich result it ' +
        'was meant to earn is lost.',
      evidence: broken.slice(0, 3),
      fix: 'Validate every JSON-LD block with the Rich Results Test before shipping.',
    });
  }
  const types = collectTypes(parsed);
  if (!types.length) {
    const local = d.telLinks.length || d.hasAddressElement;
    add({
      id: 'structured-data-missing',
      severity: 'medium',
      title: 'No structured data on the page',
      detail: 'Schema.org markup is how a business earns knowledge-panel and rich ' +
        'results, and it is increasingly what AI search engines read to cite a source.',
      evidence: ['no parseable JSON-LD; ' + d.microdataItems + ' microdata items'],
      fix: local ? localBusinessSnippet(page) : organizationSnippet(page),
    });
  }

  // ----------------------------------------------------------- content depth
  if (d.wordCount < THIN_CONTENT_WORDS) {
    add({
      id: 'thin-content',
      severity: 'medium',
      title: 'Only ' + d.wordCount + ' words of visible text',
      detail: 'Thin pages rarely rank for anything competitive: there is not enough ' +
        'text for a search engine to establish what the page answers.',
      evidence: ['"' + d.textSample.slice(0, 160) + '…"'],
      fix: 'Expand to 600+ words covering the service, who it is for, what is ' +
        'included, and the questions buyers actually ask.',
    });
  }

  // ------------------------------------------------------------------ links
  const unsafeTargets = d.links.filter(
    (l) => l.target === '_blank' && !(l.rel || '').includes('noopener'),
  );
  if (unsafeTargets.length) {
    add({
      id: 'target-blank-without-noopener',
      severity: 'low',
      title: unsafeTargets.length + ' link(s) open a new tab without rel="noopener"',
      detail: 'The opened page gets a handle back to yours via window.opener. Modern ' +
        'browsers imply noopener, but older ones do not.',
      evidence: unsafeTargets.slice(0, 5).map((l) => l.raw),
      fix: 'Add `rel="noopener noreferrer"` to every `target="_blank"` link.',
    });
  }

  const emptyAnchors = d.links.filter(
    (l) => !l.text && !l.ariaLabel && !l.hasImage && l.raw && !l.raw.startsWith('#'),
  );
  if (emptyAnchors.length) {
    add({
      id: 'links-without-text',
      severity: 'low',
      title: emptyAnchors.length + ' link(s) with no discernible text',
      detail: 'Anchor text is a ranking signal for the destination and the only label ' +
        'a screen reader can announce.',
      evidence: emptyAnchors.slice(0, 5).map((l) => l.raw),
      fix: 'Give the link visible text or an `aria-label`.',
    });
  }

  if (d.metaKeywords) {
    add({
      id: 'meta-keywords-present',
      severity: 'low',
      title: 'Obsolete meta keywords tag',
      detail: 'No search engine has used this since 2009; it only advertises your ' +
        'keyword targets to competitors.',
      evidence: ['content="' + d.metaKeywords.slice(0, 80) + '"'],
      fix: 'Delete the meta keywords tag.',
    });
  }

  return findings;
}

/** Cross-page checks: only meaningful once several pages have been crawled. */
export function analyzeSiteSeo(pages) {
  const findings = [];
  const add = (f) => findings.push({ area: 'seo', scope: 'site', ...f });

  const byTitle = new Map();
  const byDesc = new Map();
  for (const page of pages) {
    if (page.error) continue;
    const title = (page.seo.title || '').trim();
    const desc = (page.seo.metaDescription || '').trim();
    if (title) {
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(page.url);
    }
    if (desc) {
      if (!byDesc.has(desc)) byDesc.set(desc, []);
      byDesc.get(desc).push(page.url);
    }
  }

  const dupTitles = [...byTitle.entries()].filter(([, urls]) => urls.length > 1);
  if (dupTitles.length) {
    add({
      id: 'duplicate-titles',
      severity: 'high',
      title: dupTitles.length + ' title(s) reused across pages',
      detail: 'Duplicate titles make pages compete with each other and signal ' +
        'thin/templated content.',
      evidence: dupTitles.slice(0, 5).map(
        ([title, urls]) => '"' + title + '" → ' + urls.length + ' pages: ' + urls.slice(0, 3).join(', '),
      ),
      fix: 'Give every indexable page a distinct title built from its own topic.',
    });
  }

  const dupDescs = [...byDesc.entries()].filter(([, urls]) => urls.length > 1);
  if (dupDescs.length) {
    add({
      id: 'duplicate-descriptions',
      severity: 'medium',
      title: dupDescs.length + ' meta description(s) reused across pages',
      detail: 'Templated descriptions get rewritten by Google, usually worse than a ' +
        'hand-written one.',
      evidence: dupDescs.slice(0, 5).map(
        ([desc, urls]) => '"' + desc.slice(0, 60) + '…" → ' + urls.length + ' pages',
      ),
      fix: 'Write a description per page.',
    });
  }

  return findings;
}

function collectTypes(parsed) {
  const types = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node['@type']) {
      const t = node['@type'];
      (Array.isArray(t) ? t : [t]).forEach((x) => types.add(String(x)));
    }
    if (node['@graph']) visit(node['@graph']);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  parsed.forEach(visit);
  return [...types];
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (u) => (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
    return norm(ua) === norm(ub);
  } catch {
    return false;
  }
}

function shortSrc(src) {
  if (!src) return '(no src)';
  try {
    const url = new URL(src);
    return url.pathname.split('/').pop() || url.pathname;
  } catch {
    return src.slice(0, 60);
  }
}

function localBusinessSnippet(page) {
  const origin = safeOrigin(page.url);
  return [
    'The page exposes a phone number and/or postal address, so LocalBusiness is the',
    'right type. Add one block in <head>:',
    '',
    '```html',
    '<script type="application/ld+json">',
    '{',
    '  "@context": "https://schema.org",',
    '  "@type": "LocalBusiness",',
    '  "name": "…",',
    '  "url": "' + origin + '",',
    '  "logo": "' + origin + '/logo.png",',
    '  "telephone": "+27 …",',
    '  "email": "…",',
    '  "address": {',
    '    "@type": "PostalAddress",',
    '    "streetAddress": "…",',
    '    "addressLocality": "…",',
    '    "addressRegion": "…",',
    '    "postalCode": "…",',
    '    "addressCountry": "ZA"',
    '  },',
    '  "areaServed": "…",',
    '  "openingHours": "Mo-Fr 08:00-17:00",',
    '  "sameAs": ["https://www.linkedin.com/company/…"]',
    '}',
    '</script>',
    '```',
  ].join('\n');
}

function organizationSnippet(page) {
  const origin = safeOrigin(page.url);
  return [
    '```html',
    '<script type="application/ld+json">',
    '{',
    '  "@context": "https://schema.org",',
    '  "@type": "Organization",',
    '  "name": "…",',
    '  "url": "' + origin + '",',
    '  "logo": "' + origin + '/logo.png"',
    '}',
    '</script>',
    '```',
  ].join('\n');
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'https://example.com';
  }
}
