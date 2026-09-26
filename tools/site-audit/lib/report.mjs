/**
 * Renders findings as a prioritised Markdown remediation report.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = {
  critical: 'Critical — breaks the page or removes it from search',
  high: 'High — costs real traffic or usability',
  medium: 'Medium — clear defect worth scheduling',
  low: 'Low — polish',
};

export function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function summarise(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
  }
  return counts;
}

export function renderMarkdown({ startUrl, startedAt, pages, siteFindings, breakpoints, outDir }) {
  const lines = [];
  const pageFindings = pages.flatMap((page) =>
    (page.findings || []).map((f) => ({ ...f, url: page.url })),
  );
  const all = [...siteFindings.map((f) => ({ ...f, url: startUrl })), ...pageFindings];
  const counts = summarise(all);
  const reachable = pages.filter((p) => !p.error);

  lines.push('# Mobile responsiveness & SEO audit');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push('| Site | ' + startUrl + ' |');
  lines.push('| Audited | ' + startedAt + ' |');
  lines.push('| Pages crawled | ' + reachable.length + ' of ' + pages.length + ' attempted |');
  lines.push('| Breakpoints | ' + breakpoints.map((b) => b.width + 'px').join(', ') + ' |');
  lines.push('| Findings | ' +
    counts.critical + ' critical, ' + counts.high + ' high, ' +
    counts.medium + ' medium, ' + counts.low + ' low |');
  lines.push('');

  const failed = pages.filter((p) => p.error);
  if (failed.length) {
    lines.push('> **' + failed.length + ' page(s) could not be loaded.** ' +
      failed.map((p) => p.url + ' (' + p.error + ')').join('; '));
    lines.push('');
  }

  // ------------------------------------------------------------- fix plan
  lines.push('## Fix plan');
  lines.push('');
  if (!all.length) {
    lines.push('No defects detected by the automated checks.');
    lines.push('');
  } else {
    lines.push('| # | Severity | Area | Finding | Where |');
    lines.push('|---|---|---|---|---|');
    const ordered = [...all].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    ordered.forEach((f, i) => {
      const where = f.scope === 'site' ? 'site-wide' : shortPath(f.url);
      lines.push(
        '| ' + (i + 1) + ' | ' + f.severity + ' | ' + f.area + ' | ' +
        escapePipes(f.title) + ' | ' + escapePipes(where) + ' |',
      );
    });
    lines.push('');
  }

  // ------------------------------------------------------- detailed findings
  for (const severity of SEVERITY_ORDER) {
    const group = all.filter((f) => f.severity === severity);
    if (!group.length) continue;
    lines.push('## ' + SEVERITY_LABEL[severity]);
    lines.push('');
    for (const finding of group) {
      lines.push('### ' + finding.title);
      lines.push('');
      lines.push('- **Area:** ' + finding.area);
      lines.push('- **Scope:** ' + (finding.scope === 'site' ? 'site-wide' : finding.url));
      lines.push('- **Check id:** `' + finding.id + '`');
      lines.push('');
      lines.push(finding.detail);
      lines.push('');
      if (finding.evidence && finding.evidence.length) {
        lines.push('**Evidence**');
        lines.push('');
        lines.push('```');
        for (const item of finding.evidence) lines.push(String(item));
        lines.push('```');
        lines.push('');
      }
      if (finding.fix) {
        lines.push('**Fix**');
        lines.push('');
        lines.push(finding.fix);
        lines.push('');
      }
    }
  }

  // ---------------------------------------------------------- page appendix
  lines.push('## Page-by-page reference');
  lines.push('');
  for (const page of pages) {
    lines.push('### ' + page.url);
    lines.push('');
    if (page.error) {
      lines.push('Could not be loaded: `' + page.error + '`');
      lines.push('');
      continue;
    }
    const seo = page.seo;
    lines.push('- **Title** (' + (seo.title || '').length + ' chars): ' + (seo.title || '_missing_'));
    lines.push('- **Description** (' + (seo.metaDescription || '').length + ' chars): ' +
      (seo.metaDescription || '_missing_'));
    lines.push('- **H1:** ' + (seo.headings.filter((h) => h.level === 1).map((h) => h.text).join(' / ') || '_missing_'));
    lines.push('- **Canonical:** ' + (seo.canonicals[0] || '_missing_'));
    lines.push('- **Words:** ' + seo.wordCount + ' · **Images:** ' + seo.images.length +
      ' (' + seo.images.filter((i) => !i.hasAlt).length + ' without alt)' +
      ' · **Links:** ' + seo.links.length);
    if (page.cwv) {
      lines.push('- **Mobile vitals:** LCP ' + fmtMs(page.cwv.lcp) + ' · CLS ' +
        page.cwv.cls + ' · FCP ' + fmtMs(page.cwv.fcp) + ' · TTFB ' + fmtMs(page.cwv.ttfb));
    }
    for (const bp of page.breakpoints || []) {
      lines.push('- **' + bp.width + 'px:** ' +
        (bp.data.overflowPx > 1
          ? 'scrolls ' + bp.data.overflowPx + 'px sideways'
          : 'no horizontal scroll') +
        (bp.data.overflowElements.length
          ? ' · ' + bp.data.overflowElements.length + ' element(s) past the edge'
          : ''));
    }
    if (page.screenshots && page.screenshots.length) {
      lines.push('- **Screenshots:** ' + page.screenshots.map((s) => '`' + s + '`').join(', '));
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Raw data: `' + outDir + '/report.json`. Re-run with ' +
    '`node audit.mjs ' + startUrl + '` after each fix to confirm the finding clears.');
  lines.push('');

  return lines.join('\n');
}

function fmtMs(value) {
  return value === null || value === undefined ? 'n/a' : value + 'ms';
}

function escapePipes(text) {
  return String(text).replace(/\|/g, '\\|');
}

function shortPath(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}
