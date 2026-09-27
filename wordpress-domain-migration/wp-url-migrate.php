<?php
/**
 * wp-url-migrate.php
 *
 * Serialization-safe domain search/replace for a WordPress + WooCommerce site
 * that has been moved to a new domain.
 *
 * WHY YOU NEED THIS INSTEAD OF PLAIN SQL
 *   A naive "UPDATE ... SET x = REPLACE(x, 'old', 'new')" silently corrupts
 *   WordPress. Theme options, widgets and page-builder layouts are stored as
 *   PHP serialized strings which embed the BYTE LENGTH of every string:
 *       s:31:"https://digitalsoftwarevault.com"
 *   Change the text without changing the "31" and the value stops unserializing,
 *   so the theme/widget/layout silently reverts to defaults. This script
 *   unserializes, rewrites, and re-serializes so the lengths stay correct.
 *   It also handles JSON-escaped slashes (https:\/\/old) used by Elementor,
 *   WPBakery, Divi and WooCommerce settings blobs.
 *
 * HOW TO USE
 *   1. TAKE A FULL DATABASE BACKUP FIRST. This rewrites data in place.
 *   2. Edit the CONFIG block below: TOKEN, OLD_DOMAIN, NEW_DOMAIN.
 *   3. Upload this file next to wp-config.php in the site root.
 *   4. Dry run (changes nothing, just reports):
 *        https://bokashibransa.co.za/wp-url-migrate.php?token=YOURTOKEN
 *   5. Apply for real:
 *        https://bokashibransa.co.za/wp-url-migrate.php?token=YOURTOKEN&apply=1
 *   6. DELETE THIS FILE from the server the moment you are done.
 *
 *   CLI equivalent (if you have SSH):
 *        php wp-url-migrate.php --token=YOURTOKEN
 *        php wp-url-migrate.php --token=YOURTOKEN --apply
 */

/* ----------------------------- CONFIG ----------------------------------- */

/** Change this to any random string. The script refuses to run until you do. */
define('BBM_TOKEN', 'CHANGE-ME-TO-SOMETHING-RANDOM');

/** Bare hostnames, no scheme, no trailing slash, no "www." */
define('BBM_OLD_DOMAIN', 'digitalsoftwarevault.com');
define('BBM_NEW_DOMAIN', 'bokashibransa.co.za');

/** Rows read per query. Lower it if the host kills the script for memory. */
define('BBM_BATCH', 500);

/* --------------------------- END CONFIG --------------------------------- */

$bbm_is_cli = (PHP_SAPI === 'cli');

if (!$bbm_is_cli) {
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Robots-Tag: noindex, nofollow');
}

/** Collect token / apply flag from either CLI or query string. */
$bbm_token = '';
$bbm_apply = false;
if ($bbm_is_cli) {
    foreach (array_slice($argv, 1) as $arg) {
        if (strpos($arg, '--token=') === 0) { $bbm_token = substr($arg, 8); }
        if ($arg === '--apply')             { $bbm_apply = true; }
    }
} else {
    $bbm_token = isset($_GET['token']) ? (string) $_GET['token'] : '';
    $bbm_apply = isset($_GET['apply']) && $_GET['apply'] === '1';
}

if (BBM_TOKEN === 'CHANGE-ME-TO-SOMETHING-RANDOM') {
    bbm_die('Refusing to run: edit BBM_TOKEN in this file first.');
}
if (!hash_equals(BBM_TOKEN, $bbm_token)) {
    bbm_die('Refusing to run: bad or missing token.');
}
if (BBM_OLD_DOMAIN === '' || BBM_NEW_DOMAIN === '' || BBM_OLD_DOMAIN === BBM_NEW_DOMAIN) {
    bbm_die('Refusing to run: check BBM_OLD_DOMAIN / BBM_NEW_DOMAIN.');
}

function bbm_die($msg) {
    echo $msg . PHP_EOL;
    exit(1);
}

/* Load WordPress so we get $wpdb and is_serialized(). */
$bbm_root = __DIR__;
if (!file_exists($bbm_root . '/wp-load.php')) {
    bbm_die('Could not find wp-load.php. Put this file in the WordPress root, next to wp-config.php.');
}
define('SHORTINIT', false);
require_once $bbm_root . '/wp-load.php';

global $wpdb;

/**
 * Build the replacement map.
 *
 * strtr() with an array replaces the LONGEST matching key first and never
 * re-scans text it has already replaced, so we do not have to worry about
 * "https://old" being clobbered by a later bare "old" rule.
 */
function bbm_build_pairs($old, $new) {
    $pairs = array(
        'https://www.' . $old => 'https://' . $new,
        'http://www.'  . $old => 'https://' . $new,
        'https://'     . $old => 'https://' . $new,
        'http://'      . $old => 'https://' . $new,
        '//www.'       . $old => '//' . $new,
        '//'           . $old => '//' . $new,
        'www.'         . $old => $new,
        $old                  => $new,
    );

    // JSON / JS escaped-slash variants: https:\/\/old  ->  https:\/\/new
    foreach ($pairs as $from => $to) {
        $efrom = str_replace('/', '\\/', $from);
        $eto   = str_replace('/', '\\/', $to);
        if ($efrom !== $from && !isset($pairs[$efrom])) {
            $pairs[$efrom] = $eto;
        }
    }

    return $pairs;
}

/**
 * Recursively rewrite a value, descending into serialized strings, arrays
 * and objects so that serialized byte lengths are regenerated correctly.
 */
function bbm_walk($data, array $pairs, &$changed) {
    if (is_string($data)) {
        if ($data !== '' && is_serialized($data)) {
            $un = @unserialize($data);
            if ($un !== false || $data === 'b:0;') {
                // Fidelity guard: only touch values we can re-serialize byte
                // for byte. Anything else (incomplete classes, odd encodings)
                // is left exactly as found rather than risking corruption.
                if (@serialize($un) === $data) {
                    $sub = false;
                    $new = bbm_walk($un, $pairs, $sub);
                    if ($sub) {
                        $changed = true;
                        return serialize($new);
                    }
                    return $data;
                }
                return $data;
            }
        }
        $new = strtr($data, $pairs);
        if ($new !== $data) {
            $changed = true;
        }
        return $new;
    }

    if (is_array($data)) {
        $out = array();
        foreach ($data as $k => $v) {
            $out[$k] = bbm_walk($v, $pairs, $changed);
        }
        return $out;
    }

    if (is_object($data)) {
        if ($data instanceof __PHP_Incomplete_Class) {
            return $data;
        }
        $clone = clone $data;
        foreach (get_object_vars($clone) as $k => $v) {
            $clone->$k = bbm_walk($v, $pairs, $changed);
        }
        return $clone;
    }

    return $data;
}

$pairs = bbm_build_pairs(BBM_OLD_DOMAIN, BBM_NEW_DOMAIN);

echo '== WordPress domain migration ==' . PHP_EOL;
echo 'Old domain : ' . BBM_OLD_DOMAIN . PHP_EOL;
echo 'New domain : ' . BBM_NEW_DOMAIN . PHP_EOL;
echo 'Mode       : ' . ($bbm_apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes written)') . PHP_EOL;
echo str_repeat('-', 60) . PHP_EOL;

$prefix = isset($wpdb->base_prefix) ? $wpdb->base_prefix : $wpdb->prefix;
$tables = $wpdb->get_col('SHOW TABLES');

$total_cells = 0;
$total_rows  = 0;
$skipped     = array();

foreach ($tables as $table) {
    if (strpos($table, $prefix) !== 0) {
        continue; // not part of this WordPress install
    }

    $cols = $wpdb->get_results('DESCRIBE `' . $table . '`');
    if (!$cols) {
        continue;
    }

    $pk_cols   = array();
    $text_cols = array();
    foreach ($cols as $col) {
        if ($col->Key === 'PRI') {
            $pk_cols[] = $col->Field;
        }
        if (preg_match('/^(char|varchar|tinytext|text|mediumtext|longtext)/i', $col->Type)) {
            $text_cols[] = $col->Field;
        }
    }

    if (!$text_cols) {
        continue; // nothing that could hold a URL
    }
    if (!$pk_cols) {
        // Without a primary key we cannot target a row safely for UPDATE.
        $skipped[] = $table . ' (no primary key)';
        continue;
    }

    $table_cells = 0;
    $offset      = 0;

    while (true) {
        $rows = $wpdb->get_results(
            'SELECT * FROM `' . $table . '` LIMIT ' . (int) BBM_BATCH . ' OFFSET ' . (int) $offset,
            ARRAY_A
        );
        if (!$rows) {
            break;
        }

        foreach ($rows as $row) {
            $total_rows++;
            $update = array();

            foreach ($text_cols as $col) {
                if (!isset($row[$col]) || $row[$col] === null) {
                    continue;
                }
                $changed = false;
                $new     = bbm_walk($row[$col], $pairs, $changed);
                if ($changed) {
                    $update[$col] = $new;
                }
            }

            if ($update) {
                $table_cells += count($update);

                if ($bbm_apply) {
                    $where = array();
                    foreach ($pk_cols as $pk) {
                        $where[$pk] = $row[$pk];
                    }
                    $result = $wpdb->update($table, $update, $where);
                    if ($result === false) {
                        echo '  !! UPDATE failed on ' . $table . ': ' . $wpdb->last_error . PHP_EOL;
                    }
                }
            }
        }

        $offset += BBM_BATCH;
    }

    if ($table_cells > 0) {
        printf("%-40s %6d value(s)%s" . PHP_EOL,
            $table, $table_cells, $bbm_apply ? ' updated' : ' would change');
        $total_cells += $table_cells;
    }
}

echo str_repeat('-', 60) . PHP_EOL;
echo 'Rows scanned   : ' . $total_rows . PHP_EOL;
echo 'Values changed : ' . $total_cells . ($bbm_apply ? '' : ' (dry run - nothing written)') . PHP_EOL;

if ($skipped) {
    echo 'Skipped tables : ' . implode(', ', $skipped) . PHP_EOL;
}

if ($bbm_apply) {
    // Object cache / transients will still hold pre-migration URLs.
    $wpdb->query("DELETE FROM `{$wpdb->options}` WHERE option_name LIKE '\_transient\_%' OR option_name LIKE '\_site\_transient\_%'");
    if (function_exists('wp_cache_flush')) {
        wp_cache_flush();
    }
    echo 'Transients cleared and object cache flushed.' . PHP_EOL;
    echo PHP_EOL;
    echo 'NEXT: remove WP_HOME/WP_SITEURL overrides from wp-config.php if you added them,' . PHP_EOL;
    echo '      then go to Settings > Permalinks and click Save to rebuild .htaccess.' . PHP_EOL;
}

echo PHP_EOL . '*** DELETE THIS FILE FROM THE SERVER NOW. ***' . PHP_EOL;
