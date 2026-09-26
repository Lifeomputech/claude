# site-audit

A mobile-responsiveness and SEO auditor that renders a site in real Chromium at
phone widths, walks the DOM for layout and metadata defects, checks
robots/sitemap/redirects at the HTTP level, and writes a prioritised Markdown
remediation report with the CSS/HTML to paste in.

It is built for the "repair what needs repairing" job: every finding names the
offending selector or tag, explains why it costs traffic or usability, and gives
a concrete fix — not a score out of 100.

## Running it

```bash
cd tools/site-audit
npm install playwright            # skip if playwright is already available
npx playwright install chromium   # skip if Chromium is already installed

node audit.mjs https://example.com
```

Output lands in `audit-<host>-<timestamp>/`:

| File | Contents |
|---|---|
| `report.md` | Prioritised fix plan, every finding with evidence and a fix, page-by-page reference |
| `report.json` | Raw probe data for diffing between runs |
| `screenshots/` | Full-page capture per page per breakpoint |

Exit status is `0` when clean, `1` when there are critical findings, `2` when the
audit itself could not run — so it drops straight into CI.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--max-pages N` | `8` | Breadth-first crawl budget, same origin only |
| `--breakpoints LIST` | `320,390,768` | Widths to render at; the narrowest drives the layout checks |
| `--out DIR` | `audit-<host>-<timestamp>` | Output directory |
| `--proxy URL` | `$HTTPS_PROXY` | Explicit proxy (ignored for loopback targets) |
| `--no-proxy` | — | Ignore `$HTTPS_PROXY` entirely |
| `--timeout MS` | `45000` | Per-navigation timeout |
| `--ignore-robots` | off | Crawl URLs that `robots.txt` disallows |
| `--no-screenshots` | off | Skip captures (much faster) |
| `--json-only` | off | Write `report.json` only |

The crawl honours `robots.txt` by default and emulates a real phone (mobile user
agent, touch, 2x DPR) so themes that serve a different layout to mobile are
audited as a phone actually sees them.

## What it checks

**Mobile responsiveness** — viewport meta correctness and whether pinch-zoom is
blocked; horizontal scroll, with the element that breaks out named (including a
nested child that pushes further than its wrapper); overflow masked by
`overflow-x: hidden`; hard-coded widths and `min-width` larger than the screen;
tables and embeds with no scroll container; tap targets against WCAG 2.2 SC
2.5.8 (24px plus spacing) and the 44px recommendation, exempting inline prose
links; text rendering below 12px; images that are not fluid, are served far
larger than they display, or carry no intrinsic dimensions; eager loading;
fixed/sticky chrome eating the viewport; and Core Web Vitals (LCP, CLS with the
shifting elements named, FCP, TTFB) measured on an emulated phone.

**SEO** — title and meta description presence, length and cross-page
uniqueness; `noindex` via meta or `X-Robots-Tag`; canonical presence,
duplication and self-reference; `html lang`; H1 presence/count and heading
hierarchy; missing `alt`; Open Graph and Twitter cards; JSON-LD presence and
validity, with a `LocalBusiness` or `Organization` snippet emitted when there is
none; thin content; `target="_blank"` without `rel="noopener"`; links with no
discernible text; obsolete meta keywords.

**Site level** — `robots.txt` presence, a blanket `Disallow: /`, and the
`Sitemap:` directive; XML sitemap discovery across four conventional locations
plus whatever `robots.txt` advertises, and whether it is empty; HTTP→HTTPS
redirect; www/non-www canonicalisation; redirect chain length; soft 404s;
compression, HSTS and charset headers.

Severity ranks the work rather than the alarm: `critical` breaks the page on a
phone or removes it from search, `high` costs real traffic or usability,
`medium` is a clear defect worth scheduling, `low` is polish.

## Layout

```
audit.mjs                   CLI, crawl loop, orchestration
lib/probes.mjs              browser-side collection (serialised into the page)
lib/analyze-responsive.mjs  layout/vitals findings
lib/analyze-seo.mjs         per-page and cross-page SEO findings
lib/site-checks.mjs         robots, sitemap, redirects, 404s, headers
lib/report.mjs              Markdown rendering
test/run-tests.mjs          verification
```

Probes only gather data; all judgement lives in the analyzers, so a rule can be
tuned without touching page instrumentation.

## Applying the fixes

For a WordPress target, `fixes/wordpress/` holds the baseline repair layer —
the defect classes that do not need the audit to identify. `fixes/wordpress/APPLY.md`
has the install order, and the suite below proves the patch clears the defects
it claims to.

## Tests

```bash
npm test
```

The suite serves two fixtures on loopback — one deliberately broken, one built
the way the report says to build it — runs the real audit against each, and
asserts that the broken page trips all 23 expected checks while the clean page
trips nothing above `low` severity. That second half is the important one: it is
what stops the tool from generating busywork.

It then runs a before/after pass: a WordPress-style page carrying the classic
defects is audited, and audited again with `fixes/wordpress/` applied, asserting
every defect class that layer claims to fix is cleared. 71 checks in total.
