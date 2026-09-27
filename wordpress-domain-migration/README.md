# Fixing bokashibransa.co.za after the move from digitalsoftwarevault.com

WordPress + WooCommerce, moved from **Namecheap** to **Xneelo**, and renamed at the
same time. Pages render but the site looks broken/unstyled.

---

## What is actually wrong

DNS is **not** the problem. Both names resolve correctly:

| Domain | IP | Reverse DNS | Provider |
|---|---|---|---|
| `bokashibransa.co.za` | 41.203.18.90 | `www88.jnb2.host-h.net` | Xneelo (Hetzner SA), Johannesburg |
| `digitalsoftwarevault.com` | 192.64.117.58 | `business183-2.web-hosting.com` | Namecheap shared hosting |

`www.` resolves for both, so the new domain is pointed at a real, live server.

The breakage is **inside the WordPress database**. WordPress does not store
relative URLs — it stores fully-qualified absolute ones. After a rename, the
database still says the site lives at `digitalsoftwarevault.com`, so Xneelo
serves your HTML but every stylesheet, script and image inside that HTML still
points at the old Namecheap domain. The browser fetches the page from one host
and then fails (or cross-loads) every asset from another. That is exactly the
"loads but looks broken" symptom.

The stale URLs live in at least four places:

1. `wp_options.siteurl` and `wp_options.home` — plain strings.
2. Absolute URLs inside post/page content and WooCommerce product descriptions.
3. Theme options, widgets and customizer settings — **PHP serialized** data.
4. Page-builder layouts (Elementor, WPBakery, Divi) — **JSON with escaped
   slashes** (`https:\/\/digitalsoftwarevault.com`), often nested *inside*
   serialized data.

### Why you must not "just run a SQL REPLACE"

This is the single most common way people destroy a WordPress site during a
rename. Serialized data embeds the **byte length** of every string:

```
s:31:"https://digitalsoftwarevault.com"
```

Change the text without recomputing the `31` and the value stops unserializing.
WordPress then silently discards it and falls back to defaults — your theme
settings, widgets and page layouts vanish, and it is not obvious until much
later. Use one of the two serialization-safe methods below.

---

## Before you touch anything

**Take a full backup — database *and* files.** Everything below rewrites data
in place. In the Xneelo control panel use the backup tool, or export the
database from phpMyAdmin. Do not skip this; it is your only rollback.

---

## Step 0 — Confirm the diagnosis (30 seconds)

Open `https://bokashibransa.co.za/`, press `Ctrl+U` (View Source), then `Ctrl+F`
for `digitalsoftwarevault`.

- **Matches found** → confirmed, continue below.
- **No matches** → the cause is something else (see *If that was not it*).

Worth knowing: the old Namecheap site is still live. That means some assets may
still be loading from it, so parts of the site can look deceptively fine. **Do
not cancel the Namecheap hosting until this is finished and verified** — and
understand that until you fix this, your new site is quietly depending on it.

---

## Step 1 — Regain admin access

If `wp-admin` on the new domain bounces you to the old one, edit `wp-config.php`
in the site root and add these **above** the `/* That's all, stop editing! */`
line:

```php
define( 'WP_HOME',    'https://bokashibransa.co.za' );
define( 'WP_SITEURL', 'https://bokashibransa.co.za' );
```

This is a temporary override that forces WordPress onto the new domain so you
can log in. It does **not** fix content URLs — it only unblocks you. You will
remove it in Step 3.

> Emergency alternative via phpMyAdmin. These two values are plain strings, not
> serialized, so a direct UPDATE is safe here *and only here*:
> ```sql
> UPDATE wp_options SET option_value = 'https://bokashibransa.co.za'
> WHERE option_name IN ('siteurl','home');
> ```

---

## Step 2 — Rewrite every remaining URL (serialization-safe)

Pick **one** of these.

### Option A — Better Search Replace plugin (easiest)

1. Plugins → Add New → install **Better Search Replace** → activate.
2. Tools → Better Search Replace.
3. Search for: `digitalsoftwarevault.com`
   Replace with: `bokashibransa.co.za`
4. Select **all** tables.
5. Leave **"Run as dry run"** ticked. Run it. Note how many changes it reports.
6. Untick dry run and run it for real.
7. Then run two tidy-up passes the same way, to normalise the leftovers:
   - `http://bokashibransa.co.za` → `https://bokashibransa.co.za`
   - `www.bokashibransa.co.za` → `bokashibransa.co.za`
8. Deactivate and delete the plugin when finished.

Searching for the **bare hostname** (not the full URL) is deliberate: it also
matches the escaped-slash form `https:\/\/digitalsoftwarevault.com`, because the
hostname appears inside it unescaped. Searching for `https://digitalsoftwarevault.com`
instead would miss every page-builder layout. Leave **"Replace GUIDs" off** — post
GUIDs are permanent identifiers, not URLs, and rewriting them can cause feed
readers to re-show every old post.

### Option B — `wp-url-migrate.php` (included here)

Use this if you cannot reach `wp-admin`, or you prefer a single audited pass
that handles bare, `www`, `http`, protocol-relative and escaped-slash forms in
one go.

1. Open `wp-url-migrate.php` and set `BBM_TOKEN` to any random string.
   (`BBM_OLD_DOMAIN` / `BBM_NEW_DOMAIN` are already set for your move.)
2. Upload it next to `wp-config.php` in the site root.
3. **Dry run** — writes nothing, just reports what it would change:
   `https://bokashibransa.co.za/wp-url-migrate.php?token=YOURTOKEN`
4. Read the output. If the numbers look sane, **apply**:
   `https://bokashibransa.co.za/wp-url-migrate.php?token=YOURTOKEN&apply=1`
5. **Delete the file from the server.**

With SSH: `php wp-url-migrate.php --token=YOURTOKEN` then add `--apply`.

The script unserializes, rewrites and re-serializes so byte lengths stay
correct, descends into nested arrays and objects, handles JSON-escaped slashes,
and refuses to touch any value it cannot re-serialize byte-for-byte. It also
clears transients and flushes the object cache at the end.

### Option C — WP-CLI (if Xneelo gives you SSH)

```bash
wp search-replace 'digitalsoftwarevault.com' 'bokashibransa.co.za' \
  --all-tables --precise --recurse-objects --dry-run
```
Drop `--dry-run` to apply. `--precise` and `--recurse-objects` are what make it
serialization-safe; do not omit them.

---

## Step 3 — Remove the temporary override

Delete the `WP_HOME` / `WP_SITEURL` lines you added in Step 1, so the
now-corrected database values take over. Then check
**Settings → General** shows `https://bokashibransa.co.za` for both fields.

---

## Step 4 — Rebuild permalinks

**Settings → Permalinks → Save Changes** (no need to change anything). This
regenerates `.htaccess` rewrite rules for the new host. Without it you will
typically get a working homepage but 404s on every inner page.

> **Using Option B?** Skip this — `wp-url-migrate.php` flushes the rewrite rules
> itself after applying, which is the same operation this button performs. It
> also purges WP Rocket / LiteSpeed / W3 Total Cache / WP Super Cache if any of
> them are active. That means the entire repair can be done **without ever
> logging in to wp-admin**, which matters if admin access is part of what broke.

---

## Step 5 — Clear every cache

Stale caches will keep serving old-domain HTML and make you think the fix
failed:

- Caching plugin (WP Rocket, LiteSpeed, W3 Total Cache) → Purge All.
- Xneelo server-side cache, if your package has LiteSpeed enabled.
- Cloudflare or any CDN → Purge Everything.
- Test in a private/incognito window.

---

## Step 6 — SSL certificate

Confirm the certificate actually covers the new name, both bare and `www`.
Issue/reissue a Let's Encrypt cert for `bokashibransa.co.za` **and**
`www.bokashibransa.co.za` from the Xneelo control panel. A certificate that
only covers one of the two will break the other with a browser warning.

---

## Step 7 — WooCommerce: the part that costs money

A domain move breaks payment plumbing in ways that are invisible until an order
silently fails. Work through all of these:

- **Payment gateway callback / notify / webhook URLs.** PayFast, Yoco, Ozow,
  PayGate, Peach, PayPal and Stripe each store a return/IPN URL *in the
  gateway's own dashboard*, still pointing at `digitalsoftwarevault.com`.
  Update every one. **This is the highest-risk item here** — checkout appears to
  work while orders never get marked paid.
- **WooCommerce → Settings → Advanced → Webhooks** — update delivery URLs.
- **Transactional email.** Order confirmations now send from the new domain. Add
  SPF and DKIM records for `bokashibransa.co.za` or receipts will land in spam
  or bounce. Place a test order end-to-end and confirm the email arrives.
- **WooCommerce → Status → Logs** — check for gateway errors after a test order.
- **Product images.** If any are still broken after Step 2, regenerate
  thumbnails (Regenerate Thumbnails plugin).
- Check `upload_path` / `upload_url_path` in `wp_options`. If either is set to
  an absolute Namecheap path, clear it — they should normally be empty.

---

## Step 8 — Redirect the old domain

Keep Namecheap hosting alive long enough to redirect, so existing customers,
bookmarks and search rankings follow you. In the Namecheap account's
`.htaccess` for `digitalsoftwarevault.com`:

```apache
RewriteEngine On
RewriteCond %{HTTP_HOST} ^(www\.)?digitalsoftwarevault\.com$ [NC]
RewriteRule ^(.*)$ https://bokashibransa.co.za/$1 [R=301,L]
```

A `301` is permanent and passes SEO authority across; a `302` does not. Keep it
in place for at least 6–12 months.

---

## Step 9 — Finish the move

- Google Search Console: add `bokashibransa.co.za` as a new property and submit
  a fresh sitemap. Use the Change of Address tool on the old property.
- Google Analytics / Meta Pixel / Google Ads: update the site URL and any
  domain-restricted conversion tracking.
- Google Business Profile, social profiles, email signatures.
- Regenerate the sitemap (Yoast/Rank Math → re-save settings).
- Re-verify the domain anywhere it was verified (Meta, Google Merchant Centre).

---

## Verification checklist

- [ ] View-source on the homepage contains **zero** occurrences of `digitalsoftwarevault`
- [ ] Homepage is fully styled in a private window
- [ ] An inner page and a product page load (not 404)
- [ ] Product images display
- [ ] `https://www.bokashibransa.co.za` works without a certificate warning
- [ ] Old domain 301-redirects to the new one
- [ ] `wp-admin` loads and Settings → General shows the new URL
- [ ] A test order completes **and** the order is marked paid
- [ ] Order confirmation email arrives, not in spam

---

## If that was not it

If view-source shows **no** `digitalsoftwarevault` references but the site is
still broken, the cause is different:

- **404s on inner pages only** → `.htaccess` missing or `AllowOverride` off.
  Redo Step 4; check `.htaccess` was actually copied across from Namecheap.
- **Mixed-content warnings in the browser console** → assets loading over
  `http://`. Install Really Simple SSL, or force HTTPS in `.htaccess`.
- **Blank white page** → PHP fatal error. Enable `WP_DEBUG_LOG` in
  `wp-config.php` and read `wp-content/debug.log`. Usually a PHP version
  mismatch between Namecheap and Xneelo — check the PHP version in the Xneelo
  control panel matches what the site ran on before.
- **Database connection error** → `wp-config.php` still holds Namecheap's DB
  credentials. Update `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST` to the
  Xneelo values.

---

## Rollback

If anything goes wrong, restore the database backup from *Before you touch
anything*. That is why it is the first step and not a footnote.

---

## One thing to confirm

There is an existing, live WooCommerce store at **`bokashibran.co.za`** — same
brand, without the `sa`. If that is also yours, running two near-identical
stores will split your SEO and confuse customers; pick one canonical domain and
301 the other to it. If it is not yours, you have a brand/domain collision worth
sorting out before you invest further in this name.
