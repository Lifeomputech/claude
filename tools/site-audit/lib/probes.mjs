/**
 * Browser-side probes.
 *
 * Every function in this file is serialised and executed inside the page by
 * Playwright, so it may not close over any Node scope and must return plain
 * JSON. Each probe walks the DOM exactly once per breakpoint; all judgement
 * about what counts as a defect happens back in Node (see analyze-*.mjs).
 */

/** Collected once per breakpoint: everything the responsive checks need. */
export function probeResponsive() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const docEl = document.documentElement;
  const body = document.body;

  const TARGET_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    'summary', '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  ].join(', ');

  // WCAG 2.2 SC 2.5.8 (AA) minimum; 44px is the Apple/Material recommendation.
  const MIN_TARGET = 24;
  const RECOMMENDED_TARGET = 44;

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === body) return 'body';
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + CSS.escape(node.id));
        break;
      }
      const classes = (node.getAttribute('class') || '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length) part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
  }

  function isVisible(style, rect) {
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      parseFloat(style.opacity || '1') > 0.01;
  }

  // An element sitting inside a scroll or clip container is contained by
  // design — a wide table in `overflow-x: auto` is the recommended fix, not a
  // defect. html/body are excluded because clipping there is the masking
  // anti-pattern we specifically want to report.
  function hasClippingAncestor(el) {
    for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
      if (getComputedStyle(node).overflowX !== 'visible') return true;
    }
    return false;
  }

  const elements = body ? Array.from(body.querySelectorAll('*')) : [];
  // One computed-style read per element; getComputedStyle is the expensive call.
  const styled = [];
  for (const el of elements) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(style, rect)) continue;
    styled.push({ el, style, rect });
  }

  // ---------------------------------------------------------------- overflow
  const scrollWidth = Math.max(
    docEl.scrollWidth,
    docEl.offsetWidth,
    body ? body.scrollWidth : 0,
  );

  const offenders = new Set();
  const geometry = new Map();
  for (const { el, style, rect } of styled) {
    // Fixed elements are painted relative to the viewport and never extend the
    // scrollable document, so they cannot be the cause of horizontal scroll.
    if (style.position === 'fixed') continue;
    if (hasClippingAncestor(el)) continue;
    if (rect.right > vw + 1 || rect.left < -1) {
      offenders.add(el);
      geometry.set(el, {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        minWidth: style.minWidth,
        position: style.position,
        overflowBy: Math.round(Math.max(rect.right - vw, -rect.left)),
      });
    }
  }

  // A child that sticks out only because its parent already does is noise, but a
  // child that pushes the boundary *further* than every offending ancestor is
  // the real culprit (a 1600px image inside a 900px wrapper, say). Keep an
  // element when it extends past everything above it.
  const breakoutRoots = [];
  for (const el of offenders) {
    const own = geometry.get(el);
    let ancestorReach = vw;
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const box = geometry.get(ancestor);
      if (box) ancestorReach = Math.max(ancestorReach, box.right);
    }
    if (own.right > ancestorReach + 1) breakoutRoots.push(el);
  }

  const overflowElements = breakoutRoots
    .sort((a, b) => geometry.get(b).overflowBy - geometry.get(a).overflowBy)
    .slice(0, 15)
    .map((el) => ({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: textOf(el),
      ...geometry.get(el),
    }));

  // --------------------------------------------------------------- viewport
  const viewportMeta = document.querySelector('meta[name="viewport" i]');

  // ------------------------------------------------------------ tap targets
  const targets = [];
  for (const { el, style, rect } of styled) {
    if (!el.matches(TARGET_SELECTOR)) continue;
    if (el.disabled) continue;
    targets.push({ el, style, rect });
    if (targets.length >= 400) break; // neighbour search below is O(n^2)
  }

  // WCAG exempts a link sitting inline in a run of prose from the size rule.
  function isInlineProseLink(el, style) {
    if (el.tagName !== 'A' || style.display !== 'inline') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    const own = (el.textContent || '').trim().length;
    return (parent.textContent || '').trim().length > own + 15;
  }

  const smallTargets = [];
  for (let i = 0; i < targets.length; i++) {
    const { el, style, rect } = targets[i];
    const shortest = Math.min(rect.width, rect.height);
    if (shortest >= RECOMMENDED_TARGET) continue;
    if (isInlineProseLink(el, style)) continue;

    let nearestGap = Infinity;
    for (let j = 0; j < targets.length; j++) {
      if (i === j) continue;
      const other = targets[j];
      if (other.el.contains(el) || el.contains(other.el)) continue;
      const dx = Math.max(other.rect.left - rect.right, rect.left - other.rect.right, 0);
      const dy = Math.max(other.rect.top - rect.bottom, rect.top - other.rect.bottom, 0);
      nearestGap = Math.min(nearestGap, Math.hypot(dx, dy));
    }

    smallTargets.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: textOf(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      nearestGap: Number.isFinite(nearestGap) ? Math.round(nearestGap) : null,
      // Fails SC 2.5.8 only when it is both under 24px and crowded.
      failsWcag: shortest < MIN_TARGET && nearestGap < MIN_TARGET,
    });
  }

  // ------------------------------------------------------------- small text
  const smallText = new Map();
  if (body) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || '').trim();
      if (text.length < 12) continue;
      const el = node.parentElement;
      if (!el) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (!isVisible(style, rect)) continue;
      const fontSize = parseFloat(style.fontSize);
      if (!fontSize || fontSize >= 12) continue;
      const key = selectorFor(el);
      if (smallText.has(key)) continue;
      smallText.set(key, {
        selector: key,
        fontSize: Math.round(fontSize * 10) / 10,
        sample: text.slice(0, 60),
      });
    }
  }

  // --------------------------------------------------------- rigid geometry
  const rigid = [];
  for (const { el, style, rect } of styled) {
    // A `min-width` that only has to fit inside a scroll container is fine.
    if (hasClippingAncestor(el)) continue;
    const minWidth = style.minWidth.endsWith('px') ? parseFloat(style.minWidth) : 0;
    const inline = el.getAttribute('style') || '';
    const inlineWidth = /(^|;)\s*width\s*:\s*(\d{3,})px/i.exec(inline);
    const attrWidth = parseFloat(el.getAttribute('width') || '');
    const culprits = [];
    // min-width wins over max-width, so an oversized one is always a defect.
    if (minWidth > vw) culprits.push('min-width: ' + style.minWidth);
    // A declared width only matters when nothing reins it in: `width="1600"` on
    // an image with `max-width: 100%` is the recommended way to prevent layout
    // shift, not a responsiveness bug.
    const rendersTooWide = rect.width > vw + 1;
    if (rendersTooWide && inlineWidth && Number(inlineWidth[2]) > vw) {
      culprits.push('inline width: ' + inlineWidth[2] + 'px');
    }
    if (rendersTooWide && attrWidth > vw && !Number.isNaN(attrWidth)) {
      culprits.push('width="' + attrWidth + '"');
    }
    if (!culprits.length) continue;
    rigid.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      declarations: culprits,
      renderedWidth: Math.round(rect.width),
    });
    if (rigid.length >= 15) break;
  }

  // ----------------------------------------------------------------- media
  const images = Array.from(document.images).map((img) => {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return {
      src: img.currentSrc || img.src || '',
      selector: selectorFor(img),
      hasAlt: img.hasAttribute('alt'),
      alt: img.getAttribute('alt'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayedWidth: Math.round(rect.width),
      displayedHeight: Math.round(rect.height),
      widthAttr: img.getAttribute('width'),
      heightAttr: img.getAttribute('height'),
      loading: img.getAttribute('loading'),
      hasSrcset: img.hasAttribute('srcset'),
      hasSizes: img.hasAttribute('sizes'),
      maxWidth: style.maxWidth,
      visible: isVisible(style, rect),
      aspectRatio: style.aspectRatio,
    };
  });

  // Blocks that classically break mobile layouts when left unconstrained.
  const wideBlocks = [];
  for (const el of document.querySelectorAll('table, iframe, pre, video, canvas, embed, object')) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(style, rect) || rect.width <= vw + 1) continue;
    const scrollable = hasClippingAncestor(el);
    wideBlocks.push({
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      width: Math.round(rect.width),
      scrollable,
    });
  }

  // ------------------------------------------------------- viewport-eating chrome
  let pinnedChromeHeight = 0;
  const pinnedChrome = [];
  for (const { el, style, rect } of styled) {
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (rect.top > 1 && rect.bottom < vh - 1) continue; // not anchored to an edge
    if (rect.height >= vh - 1) continue;                // full-screen overlay, not chrome
    pinnedChromeHeight += rect.height;
    pinnedChrome.push({ selector: selectorFor(el), height: Math.round(rect.height) });
  }

  return {
    viewport: { width: vw, height: vh, dpr: window.devicePixelRatio },
    documentScrollWidth: Math.round(scrollWidth),
    overflowPx: Math.round(scrollWidth - vw),
    overflowElements,
    overflowX: {
      html: getComputedStyle(docEl).overflowX,
      body: body ? getComputedStyle(body).overflowX : null,
    },
    viewportMeta: viewportMeta ? viewportMeta.getAttribute('content') : null,
    viewportMetaCount: document.querySelectorAll('meta[name="viewport" i]').length,
    targetCount: targets.length,
    smallTargets: smallTargets.slice(0, 25),
    smallText: Array.from(smallText.values()).slice(0, 15),
    rigid,
    images,
    wideBlocks: wideBlocks.slice(0, 10),
    pinnedChrome: {
      totalHeight: Math.round(pinnedChromeHeight),
      viewportShare: vh ? Math.round((pinnedChromeHeight / vh) * 100) : 0,
      elements: pinnedChrome.slice(0, 5),
    },
  };
}

/** Collected once per page (head metadata, content structure, links). */
export function probeSeo() {
  const attr = (sel, name) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(name) : null;
  };
  const metaName = (name) => attr('meta[name="' + name + '" i]', 'content');
  const metaProp = (prop) => attr('meta[property="' + prop + '" i]', 'content');

  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    }))
    .filter((h) => h.text.length > 0);

  const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
    href: a.href,
    raw: a.getAttribute('href') || '',
    text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    rel: a.getAttribute('rel'),
    target: a.getAttribute('target'),
    hasImage: !!a.querySelector('img'),
    ariaLabel: a.getAttribute('aria-label'),
  }));

  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json" i]'))
    .map((s) => s.textContent || '');

  const bodyText = document.body ? (document.body.innerText || '') : '';
  const words = bodyText.trim().split(/\s+/).filter(Boolean);

  return {
    url: location.href,
    title: document.title || '',
    titleCount: document.querySelectorAll('title').length,
    metaDescription: metaName('description'),
    metaRobots: metaName('robots'),
    metaKeywords: metaName('keywords'),
    metaViewport: metaName('viewport'),
    charset: document.characterSet,
    lang: document.documentElement.getAttribute('lang'),
    canonicals: Array.from(document.querySelectorAll('link[rel="canonical" i]'))
      .map((l) => l.href),
    hreflang: Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]'))
      .map((l) => ({ hreflang: l.getAttribute('hreflang'), href: l.href })),
    favicons: Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel="apple-touch-icon" i]'))
      .map((l) => ({ rel: l.getAttribute('rel'), href: l.href })),
    openGraph: {
      title: metaProp('og:title'),
      description: metaProp('og:description'),
      image: metaProp('og:image'),
      url: metaProp('og:url'),
      type: metaProp('og:type'),
      siteName: metaProp('og:site_name'),
      locale: metaProp('og:locale'),
    },
    twitter: {
      card: metaName('twitter:card') || metaProp('twitter:card'),
      title: metaName('twitter:title') || metaProp('twitter:title'),
      description: metaName('twitter:description') || metaProp('twitter:description'),
      image: metaName('twitter:image') || metaProp('twitter:image'),
    },
    headings,
    links,
    jsonLd,
    microdataItems: document.querySelectorAll('[itemscope]').length,
    images: Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src || '',
      hasAlt: img.hasAttribute('alt'),
      alt: img.getAttribute('alt'),
      width: Math.round(img.getBoundingClientRect().width),
      height: Math.round(img.getBoundingClientRect().height),
    })),
    wordCount: words.length,
    textSample: bodyText.trim().replace(/\s+/g, ' ').slice(0, 300),
    forms: document.querySelectorAll('form').length,
    telLinks: Array.from(document.querySelectorAll('a[href^="tel:" i]')).map((a) => a.getAttribute('href')),
    mailLinks: Array.from(document.querySelectorAll('a[href^="mailto:" i]')).map((a) => a.getAttribute('href')),
    hasAddressElement: !!document.querySelector('address'),
    scripts: Array.from(document.querySelectorAll('script[src]')).length,
    stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet" i]')).length,
    generator: metaName('generator'),
  };
}

/** Injected before navigation so the observers exist when paint happens. */
export function cwvInitScript() {
  window.__cwv = { lcp: null, cls: 0, fcp: null, longTasks: 0, shifts: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__cwv.lcp = Math.round(entry.startTime);
        window.__cwv.lcpElement = entry.element
          ? entry.element.tagName.toLowerCase() + (entry.element.id ? '#' + entry.element.id : '')
          : (entry.url || null);
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__cwv.cls += entry.value;
        if (window.__cwv.shifts.length < 5) {
          window.__cwv.shifts.push({
            value: Math.round(entry.value * 1000) / 1000,
            sources: (entry.sources || []).slice(0, 2).map((s) =>
              s.node && s.node.tagName
                ? s.node.tagName.toLowerCase() + (s.node.className && typeof s.node.className === 'string'
                    ? '.' + s.node.className.trim().split(/\s+/)[0] : '')
                : 'unknown'),
          });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') window.__cwv.fcp = Math.round(entry.startTime);
      }
    }).observe({ type: 'paint', buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((list) => {
      window.__cwv.longTasks += list.getEntries().length;
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }
}

/** Read the observers back after the page has settled. */
export function readCwv() {
  const nav = performance.getEntriesByType('navigation')[0];
  const cwv = window.__cwv || {};
  return {
    ttfb: nav ? Math.round(nav.responseStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    transferSize: nav ? nav.transferSize : null,
    fcp: cwv.fcp ?? null,
    lcp: cwv.lcp ?? null,
    lcpElement: cwv.lcpElement ?? null,
    cls: Math.round((cwv.cls || 0) * 1000) / 1000,
    clsSources: cwv.shifts || [],
    longTasks: cwv.longTasks || 0,
  };
}
