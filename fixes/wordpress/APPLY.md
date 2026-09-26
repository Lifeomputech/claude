# Applying the baseline repair to WordPress

This folder is the layer of the repair that does **not** depend on seeing the
site: the defect classes that are near-universal on WordPress builds. Every rule
is either a no-op when the theme already does the right thing, or scoped to
small screens so desktop cannot regress.

The site-specific fixes — the actual selectors that break your layout, your real
titles and descriptions, your LCP image — come from the audit report. See
"What still needs the audit" at the bottom.

## What is here

| File | What it does |
|---|---|
| `dgr-responsive-repair.css` | Fluid media, flex/grid shrink fixes, table scroll styling, 44px touch targets, legible small print, 16px form fields (stops iOS zoom), fluid embeds |
| `functions-snippets.php` | Enqueues the stylesheet last, wraps wide tables in a scroll container, sets `lang="en-ZA"`, tunes image loading, emits LocalBusiness JSON-LD, optional viewport repair and LCP preload |
| `test-snippets.php` | Unit tests for the PHP transformations — run it before you paste anything live |

## Before you start

- **Take a backup**, or apply this on staging first.
- **You need a child theme.** Never edit the parent theme: the next update
  overwrites it. If there is no child theme, create one:

  ```
  wp-content/themes/<parent>-child/
    ├── style.css
    ├── functions.php
    └── dgr-responsive-repair.css
  ```

  `style.css` needs only this header:

  ```css
  /*
  Theme Name: <Parent> Child
  Template: <parent-theme-folder-name>
  */
  ```

  and `functions.php` needs the parent stylesheet enqueued:

  ```php
  <?php
  add_action( 'wp_enqueue_scripts', function () {
      wp_enqueue_style( 'parent-style', get_template_directory_uri() . '/style.css' );
  } );
  ```

  Then activate the child theme under **Appearance → Themes**. Widgets and menu
  assignments may need reassigning once.

## Steps

**1. Copy `dgr-responsive-repair.css`** into the child theme folder, next to
`style.css`.

**2. Append the contents of `functions-snippets.php`** to the child theme's
`functions.php` — everything below the `if ( ! defined( 'ABSPATH' ) )` guard.
Do not paste a second `<?php` tag if the file already opens with one.

**3. Check it loaded.** View source on the front end and search for
`dgr-responsive-repair.css`. If it is missing, the theme is not calling
`wp_head()`, or a caching plugin is serving a stale page — purge the cache.

**4. Fill in the business facts** in `dgr_business_schema()`. Every placeholder
is empty on purpose and empty values are stripped before output, so an
unfinished block emits nothing rather than asserting a blank fact. Fill in at
minimum: `logo`, `telephone`, `address`, `areaServed`, `sameAs`. Validate at
<https://search.google.com/test/rich-results> before moving on.

If an SEO plugin (Yoast, Rank Math, SEOPress) already outputs Organization or
LocalBusiness schema, **use the plugin's fields instead** and delete
`dgr_business_schema()` — two competing blocks is worse than one.

**5. Set the metadata an SEO plugin owns**, not the theme:

- A unique title per page, 50–60 characters, keyword first, brand last.
- A unique meta description per page, 140–160 characters.
- Self-referential canonicals on.
- Open Graph and Twitter card output on, with a 1200×630 default share image.
- XML sitemap on, and referenced from `robots.txt`.
- Check **Settings → Reading** and confirm *"Discourage search engines from
  indexing this site"* is **unticked**. That single checkbox writes
  `Disallow: /` and removes the site from search entirely.

**6. The viewport tag.** Most themes get this right. If the audit reports a
viewport finding, fix it at source: copy the parent's `header.php` into the
child theme and correct the tag to

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Only if the tag comes from somewhere you cannot reach, uncomment the
`add_action( 'template_redirect', 'dgr_start_viewport_buffer', 1 );` line — it
buffers the whole response, which has a cost, and it only rewrites a tag that is
actually wrong.

**7. Purge every cache** — page cache plugin, object cache, CDN. Then hard
reload on a phone.

## Verifying

Run the auditor from this repository before and after:

```bash
cd tools/site-audit
node audit.mjs https://dgrcompliancegroup.com --out before
# apply the patch set, purge caches
node audit.mjs https://dgrcompliancegroup.com --out after
```

Compare the finding counts at the top of each `report.md`. Anything still listed
is site-specific and needs the report's own fix text.

The patch set is verified the same way in CI: `tools/site-audit/test/run-tests.mjs`
serves a WordPress-style page carrying the classic defects, audits it, then
audits the same page with this patch applied and asserts every defect class
listed below is cleared. `php fixes/wordpress/test-snippets.php` covers the PHP
transformations.

Defect classes proven cleared by this layer:

`viewport-meta-not-device-width`, `viewport-zoom-disabled`,
`horizontal-overflow`, `unconstrained-blocks`, `tap-targets-too-small`,
`images-not-fluid`, `images-missing-dimensions`, `images-missing-alt`,
`html-lang-missing`, `title-too-short`, `meta-description-missing`,
`canonical-missing`, `open-graph-incomplete`, `structured-data-missing`.

## Rolling back

Delete the pasted block from `functions.php` and remove
`dgr-responsive-repair.css`. Nothing here writes to the database, changes
content, or touches the parent theme, so removal is complete and immediate.

## What still needs the audit

This layer cannot know:

- **Which selectors actually overflow.** The generic `min-width: 0` rules catch
  most page-builder rows, but a custom module with a hard-coded width needs its
  own rule. The report names the element.
- **Your real titles and descriptions.** Length and uniqueness are mechanical;
  the wording is not.
- **Which image is the LCP element**, so `dgr_preload_lcp_image()` is left
  empty. Preloading the wrong asset makes things slower.
- **Server-level items**: HTTP→HTTPS redirect, www canonicalisation, redirect
  chains, compression, HSTS, soft 404s. These are host or CDN settings, not
  theme code.
- **Whether images need regenerating.** If the audit reports images served far
  larger than they display, the fix is smaller source files plus `srcset` —
  which WordPress emits automatically for images inserted through the media
  library, and skips for hard-coded `<img>` tags in page builders.

A note on small text: while a viewport tag is broken, Chromium's text autosizing
inflates small print, so "text too small" can stay quiet until the viewport is
fixed — and then appear. Re-run the audit after step 6 rather than assuming the
first run was complete.
