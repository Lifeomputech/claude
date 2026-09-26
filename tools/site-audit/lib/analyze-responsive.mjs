/**
 * Turns the raw responsive probe output into findings.
 *
 * A finding is { id, area, severity, title, detail, evidence[], fix }.
 * Severity ranks the work, not the emotion: `critical` breaks the page on a
 * phone, `high` costs real users, `medium` is a clear defect with a workaround,
 * `low` is polish.
 */

const VIEWPORT_SAFE = /width\s*=\s*device-width/i;

function uniq(list) {
  return Array.from(new Set(list));
}

export function analyzeResponsive({ breakpoints, cwv }) {
  const findings = [];
  const narrowest = breakpoints.reduce((a, b) => (a.width <= b.width ? a : b));
  const add = (f) => findings.push({ area: 'responsive', ...f });

  // ------------------------------------------------------------ viewport meta
  const meta = narrowest.data.viewportMeta;
  if (!meta) {
    add({
      id: 'viewport-meta-missing',
      severity: 'critical',
      title: 'No viewport meta tag',
      detail:
        'Without a viewport meta tag mobile browsers render the page at a ~980px ' +
        'virtual width and scale it down, so every phone visitor gets a zoomed-out ' +
        'desktop layout. Google treats this as not mobile-friendly.',
      evidence: ['<head> contains no <meta name="viewport">'],
      fix: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    });
  } else {
    if (!VIEWPORT_SAFE.test(meta)) {
      add({
        id: 'viewport-meta-not-device-width',
        severity: 'critical',
        title: 'Viewport meta does not use width=device-width',
        detail:
          'The viewport is pinned to a fixed width, so the layout is scaled rather ' +
          'than reflowed and CSS media queries never match the real device width.',
        evidence: ['content="' + meta + '"'],
        fix: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      });
    }
    const blocksZoom =
      /user-scalable\s*=\s*(no|0)/i.test(meta) ||
      /maximum-scale\s*=\s*(1(\.0+)?|0?\.\d+)\b/i.test(meta);
    if (blocksZoom) {
      add({
        id: 'viewport-zoom-disabled',
        severity: 'high',
        title: 'Pinch-zoom is disabled',
        detail:
          'Blocking zoom fails WCAG 2.1 SC 1.4.4 (Resize Text) and locks out anyone ' +
          'who needs to magnify small print — common on a compliance site where ' +
          'people read regulation detail on a phone.',
        evidence: ['content="' + meta + '"'],
        fix: 'Remove user-scalable=no and maximum-scale; keep only ' +
          '"width=device-width, initial-scale=1".',
      });
    }
  }
  if (narrowest.data.viewportMetaCount > 1) {
    add({
      id: 'viewport-meta-duplicated',
      severity: 'medium',
      title: 'More than one viewport meta tag',
      detail: 'Duplicate viewport tags are a common symptom of a theme and a plugin ' +
        'both injecting one; the browser honours the last and the other is dead weight.',
      evidence: [narrowest.data.viewportMetaCount + ' <meta name="viewport"> tags found'],
      fix: 'Keep exactly one viewport tag, emitted by the theme header.',
    });
  }

  // --------------------------------------------------------- horizontal scroll
  const overflowing = breakpoints.filter((b) => b.data.overflowPx > 1);
  const breakingOut = breakpoints.filter((b) => b.data.overflowElements.length > 0);

  if (overflowing.length) {
    const evidence = [];
    for (const bp of overflowing) {
      evidence.push(
        'at ' + bp.width + 'px: document scrolls to ' +
        bp.data.documentScrollWidth + 'px — ' + bp.data.overflowPx + 'px too wide',
      );
    }
    for (const el of overflowing[0].data.overflowElements.slice(0, 6)) {
      evidence.push(
        '  ' + el.selector + ' — ' + el.width + 'px wide, overflows by ' +
        el.overflowBy + 'px' + (el.text ? ' ("' + el.text + '")' : ''),
      );
    }
    add({
      id: 'horizontal-overflow',
      severity: 'critical',
      title: 'Page scrolls sideways on mobile',
      detail:
        'Content is wider than the screen, so the whole page can be dragged ' +
        'horizontally. This is the single most visible mobile defect and Google ' +
        'flags it as "content wider than screen".',
      evidence,
      fix: [
        'Constrain the element listed above rather than hiding the symptom:',
        '',
        '```css',
        '/* 1. Never let replaced/embedded content exceed its column */',
        'img, video, iframe, embed, object, canvas, svg { max-width: 100%; height: auto; }',
        '',
        '/* 2. Long unbroken strings (URLs, part numbers) must be allowed to wrap */',
        'body { overflow-wrap: anywhere; }',
        '',
        '/* 3. Replace fixed widths with fluid ones */',
        '.offending-selector { width: auto; max-width: 100%; min-width: 0; }',
        '',
        '/* 4. Grid/flex children need min-width:0 or they refuse to shrink */',
        '.row > * { min-width: 0; }',
        '```',
      ].join('\n'),
    });
  } else if (breakingOut.length) {
    add({
      id: 'overflow-masked',
      severity: 'high',
      title: 'Overflowing content is hidden rather than fixed',
      detail:
        'Elements still extend past the viewport but overflow-x is clipping them, ' +
        'so the sideways scroll is masked while the content itself is cut off. ' +
        'Anything past the edge is unreadable on a phone.',
      evidence: [
        'html overflow-x: ' + narrowest.data.overflowX.html +
        ', body overflow-x: ' + narrowest.data.overflowX.body,
        ...breakingOut[0].data.overflowElements.slice(0, 5).map(
          (el) => '  ' + el.selector + ' extends ' + el.overflowBy + 'px past the viewport',
        ),
      ],
      fix: 'Remove the overflow-x clip from html/body and size the listed elements ' +
        'fluidly (max-width: 100%; min-width: 0) so the content reflows instead of ' +
        'being cropped.',
    });
  }

  // --------------------------------------------------------------- rigid boxes
  const rigid = narrowest.data.rigid;
  if (rigid.length) {
    add({
      id: 'fixed-widths',
      severity: 'high',
      title: 'Hard-coded widths wider than a phone screen',
      detail:
        'These elements declare a pixel width or min-width larger than a ' +
        narrowest.width + 'px viewport, so they can never fit a small screen.',
      evidence: rigid.slice(0, 8).map(
        (r) => r.selector + ' — ' + r.declarations.join(', '),
      ),
      fix: 'Swap fixed widths for fluid ones: `width: 100%; max-width: <px>;` and ' +
        'drop `min-width` (or set `min-width: 0`) on anything inside a flex/grid row.',
    });
  }

  // ------------------------------------------------------------- wide blocks
  const wide = narrowest.data.wideBlocks.filter((b) => !b.scrollable);
  if (wide.length) {
    const tables = wide.filter((b) => b.tag === 'table');
    add({
      id: 'unconstrained-blocks',
      severity: 'high',
      title: 'Tables/embeds wider than the screen with no scroll container',
      detail:
        'Wide block content forces the page open sideways. Tables need a scroll ' +
        'wrapper; embeds need a fluid aspect-ratio box.',
      evidence: wide.map((b) => '<' + b.tag + '> ' + b.selector + ' — ' + b.width + 'px'),
      fix: [
        tables.length
          ? '```html\n<div class="table-scroll"><table>…</table></div>\n```\n' +
            '```css\n.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }\n' +
            '.table-scroll table { min-width: 36rem; }\n```'
          : null,
        '```css\n/* Fluid, ratio-preserving embeds */\n' +
        'iframe, video { width: 100%; max-width: 100%; aspect-ratio: 16 / 9; height: auto; }\n```',
      ].filter(Boolean).join('\n\n'),
    });
  }

  // ------------------------------------------------------------- tap targets
  const failing = narrowest.data.smallTargets.filter((t) => t.failsWcag);
  const cramped = narrowest.data.smallTargets.filter((t) => !t.failsWcag);
  if (failing.length) {
    add({
      id: 'tap-targets-too-small',
      severity: 'high',
      title: failing.length + ' tap target(s) below the 24px accessible minimum',
      detail:
        'These controls are under 24x24 CSS px and sit within 24px of another ' +
        'control, which fails WCAG 2.2 SC 2.5.8 and makes them hard to hit with a ' +
        'thumb. Google reports this as "clickable elements too close together".',
      evidence: failing.slice(0, 10).map(
        (t) => '<' + t.tag + '> ' + t.selector + ' — ' + t.width + 'x' + t.height +
          'px, ' + t.nearestGap + 'px from its neighbour' + (t.text ? ' ("' + t.text + '")' : ''),
      ),
      fix: [
        '```css',
        '.nav a, .footer a, .social a, button {',
        '  min-height: 44px;',
        '  min-width: 44px;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '}',
        '/* Or keep the visual size and grow only the hit area: */',
        '.icon-link { position: relative; }',
        '.icon-link::after { content: ""; position: absolute; inset: -12px; }',
        '```',
      ].join('\n'),
    });
  }
  if (cramped.length) {
    add({
      id: 'tap-targets-below-recommended',
      severity: 'low',
      title: cramped.length + ' tap target(s) below the 44px recommended size',
      detail: 'These pass the accessibility minimum but are smaller than the 44px ' +
        'touch size Apple and Material both recommend.',
      evidence: cramped.slice(0, 8).map(
        (t) => '<' + t.tag + '> ' + t.selector + ' — ' + t.width + 'x' + t.height + 'px',
      ),
      fix: 'Raise min-height/min-width to 44px on these controls.',
    });
  }

  // ---------------------------------------------------------------- legibility
  if (narrowest.data.smallText.length) {
    add({
      id: 'text-too-small',
      severity: 'medium',
      title: 'Body text rendering below 12px',
      detail:
        'Text under 12px is the threshold Google reports as "text too small to ' +
        'read". Aim for 16px body copy on mobile; 14px is the practical floor for ' +
        'secondary text.',
      evidence: narrowest.data.smallText.map(
        (t) => t.selector + ' — ' + t.fontSize + 'px ("' + t.sample + '")',
      ),
      fix: 'Set a 16px (1rem) base font-size and use relative units for the rest: ' +
        '`body { font-size: 1rem; line-height: 1.6; }` with small print no lower than 0.875rem.',
    });
  }

  // ------------------------------------------------------------------- images
  const imgs = narrowest.data.images.filter((i) => i.visible);
  const unsized = imgs.filter((i) => !i.widthAttr || !i.heightAttr);
  const noSrcset = imgs.filter(
    (i) => !i.hasSrcset && i.naturalWidth > 0 &&
      i.naturalWidth > Math.max(i.displayedWidth * 2, narrowest.width * 1.5),
  );
  const notFluid = imgs.filter(
    (i) => i.maxWidth === 'none' && i.naturalWidth > narrowest.width,
  );

  if (notFluid.length) {
    add({
      id: 'images-not-fluid',
      severity: 'high',
      title: 'Images with no max-width constraint',
      detail: 'These images have `max-width: none` and intrinsic widths larger than ' +
        'the phone viewport, so they push the layout open.',
      evidence: notFluid.slice(0, 8).map(
        (i) => i.selector + ' — intrinsic ' + i.naturalWidth + 'px, rendered ' +
          i.displayedWidth + 'px (' + shortSrc(i.src) + ')',
      ),
      fix: '```css\nimg { max-width: 100%; height: auto; }\n```',
    });
  }
  if (noSrcset.length) {
    const wasted = noSrcset.reduce((sum, i) => sum + i.naturalWidth, 0);
    add({
      id: 'images-oversized-for-mobile',
      severity: 'medium',
      title: noSrcset.length + ' image(s) served far larger than they display',
      detail:
        'Phones download the full desktop image and scale it down, burning mobile ' +
        'data and delaying LCP. Serve width-appropriate variants via srcset.',
      evidence: noSrcset.slice(0, 8).map(
        (i) => shortSrc(i.src) + ' — ' + i.naturalWidth + 'px intrinsic vs ' +
          i.displayedWidth + 'px displayed',
      ),
      fix: [
        '```html',
        '<img src="hero-800.jpg"',
        '     srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1600.jpg 1600w"',
        '     sizes="(max-width: 600px) 100vw, 800px"',
        '     width="800" height="450" alt="…">',
        '```',
        '',
        'On WordPress this is what `the_post_thumbnail()` / `wp_get_attachment_image()` ' +
        'emit automatically — hard-coded <img> tags in page builders skip it. Total ' +
        'intrinsic width being shipped unnecessarily: ~' + wasted + 'px.',
      ].join('\n'),
    });
  }
  if (unsized.length) {
    add({
      id: 'images-missing-dimensions',
      severity: 'medium',
      title: unsized.length + ' image(s) without width/height attributes',
      detail:
        'Without intrinsic dimensions the browser cannot reserve space before the ' +
        'image loads, so the page jumps as it renders. That is measured directly as ' +
        'Cumulative Layout Shift, a Core Web Vital.',
      evidence: unsized.slice(0, 8).map(
        (i) => shortSrc(i.src) + ' — rendered ' + i.displayedWidth + 'x' + i.displayedHeight,
      ),
      fix: 'Add the real intrinsic `width` and `height` attributes to every <img> ' +
        '(CSS `height: auto` keeps it responsive), or set `aspect-ratio` in CSS.',
    });
  }

  const eagerBelowFold = imgs.filter((i) => i.loading !== 'lazy').length;
  if (imgs.length > 6 && eagerBelowFold > 6) {
    add({
      id: 'images-not-lazy',
      severity: 'low',
      title: 'Most images load eagerly',
      detail: eagerBelowFold + ' of ' + imgs.length + ' images have no ' +
        'loading="lazy", so off-screen imagery competes with above-the-fold content ' +
        'for a phone’s limited bandwidth.',
      evidence: [eagerBelowFold + ' images without loading="lazy"'],
      fix: 'Add `loading="lazy"` to below-the-fold images and `fetchpriority="high"` ' +
        'to the LCP image (never lazy-load the LCP image).',
    });
  }

  // ----------------------------------------------------------- sticky chrome
  const chrome = narrowest.data.pinnedChrome;
  if (chrome.viewportShare >= 30) {
    add({
      id: 'sticky-chrome-dominates',
      severity: 'medium',
      title: 'Fixed/sticky bars consume ' + chrome.viewportShare + '% of the phone viewport',
      detail: 'Pinned headers, cookie bars and call-to-action strips are eating the ' +
        'screen before any content is visible.',
      evidence: chrome.elements.map((e) => e.selector + ' — ' + e.height + 'px tall'),
      fix: 'Collapse sticky chrome on small screens (shrink on scroll, or drop to ' +
        '`position: static` under a `@media (max-width: 48em)` query).',
    });
  }

  // --------------------------------------------------------- Core Web Vitals
  if (cwv) {
    if (cwv.cls >= 0.1) {
      add({
        id: 'cls-poor',
        severity: cwv.cls >= 0.25 ? 'high' : 'medium',
        title: 'Cumulative Layout Shift is ' + cwv.cls + ' (target < 0.1)',
        detail: 'The layout moves while loading. CLS is a ranking signal and the ' +
          'most common cause is unsized media or web fonts swapping in.',
        evidence: (cwv.clsSources || []).map(
          (s) => 'shift of ' + s.value + ' from ' + (s.sources.join(', ') || 'unknown'),
        ),
        fix: 'Reserve space for images/ads/embeds (width+height or aspect-ratio) and ' +
          'use `font-display: optional|swap` with a matched fallback metric.',
      });
    }
    if (cwv.lcp && cwv.lcp > 2500) {
      add({
        id: 'lcp-slow',
        severity: cwv.lcp > 4000 ? 'high' : 'medium',
        title: 'Largest Contentful Paint is ' + cwv.lcp + 'ms (target < 2500ms)',
        detail: 'Measured on an emulated phone viewport. LCP is a Core Web Vital and ' +
          'slow mobile rendering suppresses rankings.',
        evidence: [
          'LCP element: ' + (cwv.lcpElement || 'unknown'),
          'TTFB: ' + cwv.ttfb + 'ms, FCP: ' + cwv.fcp + 'ms',
        ],
        fix: 'Preload the LCP image (`<link rel="preload" as="image">`), serve it as ' +
          'WebP/AVIF at the displayed size, set `fetchpriority="high"`, and defer ' +
          'non-critical CSS/JS.',
      });
    }
  }

  return findings;
}

function shortSrc(src) {
  if (!src) return '(no src)';
  try {
    const url = new URL(src);
    const parts = url.pathname.split('/');
    return parts[parts.length - 1] || url.pathname;
  } catch {
    return src.slice(0, 60);
  }
}

export { uniq };
