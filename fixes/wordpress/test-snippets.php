<?php
/**
 * Verification for functions-snippets.php.
 *
 * Stubs the handful of WordPress functions the snippets touch, loads the real
 * file, and exercises the pure transformations. Run with:
 *
 *   php fixes/wordpress/test-snippets.php
 */

define( 'ABSPATH', __DIR__ );

// --- WordPress stubs -------------------------------------------------------
$GLOBALS['dgr_hooks'] = array();
function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['dgr_hooks'][] = array( 'action', $hook, $callback );
}
function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['dgr_hooks'][] = array( 'filter', $hook, $callback );
}
function apply_filters( $hook, $value ) { return $value; }
function is_admin() { return false; }
function is_front_page() { return true; }
function wp_enqueue_style() {}
function get_stylesheet_directory() { return __DIR__; }
function get_stylesheet_directory_uri() { return 'https://example.test/wp-content/themes/child'; }
function home_url( $path = '/' ) { return 'https://example.test' . $path; }
function get_bloginfo( $key ) { return 'name' === $key ? 'Example Group' : 'Compliance and training'; }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function esc_url( $url ) { return $url; }

require __DIR__ . '/functions-snippets.php';

// --- tiny test harness -----------------------------------------------------
$failures = 0;
function check( $name, $condition, $extra = '' ) {
	global $failures;
	if ( $condition ) {
		echo "  ok   {$name}\n";
	} else {
		$failures++;
		echo "  FAIL {$name}" . ( $extra ? " — {$extra}" : '' ) . "\n";
	}
}

echo "\nviewport repair\n";
$bad = '<meta name="viewport" content="width=1024, user-scalable=no, maximum-scale=1">';
$out = dgr_fix_viewport_meta( "<head>{$bad}</head>" );
check( 'rewrites a fixed-width, zoom-blocked tag',
	false !== strpos( $out, 'width=device-width, initial-scale=1' )
	&& false === strpos( $out, 'user-scalable=no' ), $out );

$good = '<meta name="viewport" content="width=device-width, initial-scale=1">';
check( 'leaves a correct tag untouched',
	dgr_fix_viewport_meta( "<head>{$good}</head>" ) === "<head>{$good}</head>" );

$zoomOnly = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0">';
check( 'rewrites a tag that only blocks zoom',
	false === strpos( dgr_fix_viewport_meta( $zoomOnly ), 'maximum-scale' ) );

$scale5 = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">';
check( 'accepts maximum-scale=5 as zoomable',
	dgr_fix_viewport_meta( $scale5 ) === $scale5 );

check( 'no viewport tag is a no-op',
	dgr_fix_viewport_meta( '<head><title>x</title></head>' ) === '<head><title>x</title></head>' );

echo "\ntable wrapping\n";
$table = '<p>Before</p><table><tr><td>UN 1203</td></tr></table><p>After</p>';
$wrapped = dgr_wrap_content_tables( $table );
check( 'wraps a table in a scroll container',
	false !== strpos( $wrapped, '<div class="dgr-table-scroll"' )
	&& false !== strpos( $wrapped, '</table></div>' ), $wrapped );
check( 'keeps surrounding content',
	false !== strpos( $wrapped, '<p>Before</p>' ) && false !== strpos( $wrapped, '<p>After</p>' ) );
check( 'is keyboard reachable',
	false !== strpos( $wrapped, 'tabindex="0"' ) && false !== strpos( $wrapped, 'role="region"' ) );
check( 'content without a table is untouched',
	dgr_wrap_content_tables( '<p>no tables here</p>' ) === '<p>no tables here</p>' );

echo "\nimage loading\n";
$imgs = '<img src="hero.jpg" loading="lazy"><p>x</p><img src="two.jpg"><img src="three.jpg">';
$tuned = dgr_tune_image_loading( $imgs );
preg_match_all( '#<img\b[^>]*>#i', $tuned, $found );
check( 'first image is not lazy', false === strpos( $found[0][0], 'loading="lazy"' ), $found[0][0] );
check( 'first image gets high fetchpriority',
	false !== strpos( $found[0][0], 'fetchpriority="high"' ), $found[0][0] );
check( 'later images are lazy', false !== strpos( $found[0][1], 'loading="lazy"' ), $found[0][1] );
check( 'later images decode async', false !== strpos( $found[0][2], 'decoding="async"' ), $found[0][2] );
check( 'all three images survive', 3 === count( $found[0] ), (string) count( $found[0] ) );

$explicit = '<img src="a.jpg"><img src="b.jpg" loading="eager">';
$tuned2 = dgr_tune_image_loading( $explicit );
check( 'an explicit loading value is respected',
	false !== strpos( $tuned2, 'loading="eager"' ) && false === strpos( $tuned2, 'loading="lazy"' ), $tuned2 );

echo "\nlanguage attributes\n";
check( 'adds a locale when absent', 'lang="en-ZA"' === dgr_language_attributes( '' ) );
check( 'leaves an existing locale alone',
	'lang="af"' === dgr_language_attributes( 'lang="af"' ) );

echo "\nschema\n";
$kept = dgr_strip_empty( array(
	'name'    => 'Example',
	'logo'    => '',
	'address' => array( 'streetAddress' => '', 'addressCountry' => 'ZA' ),
	'sameAs'  => array(),
) );
check( 'drops blank values', ! array_key_exists( 'logo', $kept ) );
check( 'drops empty arrays', ! array_key_exists( 'sameAs', $kept ) );
check( 'drops blank nested values', ! array_key_exists( 'streetAddress', $kept['address'] ) );
check( 'keeps real values', 'ZA' === $kept['address']['addressCountry'] && 'Example' === $kept['name'] );

ob_start();
dgr_business_schema();
$printed = ob_get_clean();
check( 'emits parseable JSON-LD', (bool) preg_match( '#<script type="application/ld\+json">(.+?)</script>#s', $printed, $m )
	&& null !== json_decode( $m[1], true ), $printed );
check( 'schema asserts no blank facts', false === strpos( $printed, '""' ), $printed );

echo "\nhooks\n";
$hooked = array_map( static function ( $h ) { return $h[2]; }, $GLOBALS['dgr_hooks'] );
foreach ( array( 'dgr_enqueue_responsive_repair', 'dgr_wrap_content_tables', 'dgr_language_attributes',
	'dgr_tune_image_loading', 'dgr_business_schema', 'dgr_preload_lcp_image' ) as $fn ) {
	check( "{$fn} is registered", in_array( $fn, $hooked, true ) );
}
check( 'viewport buffer is NOT registered by default',
	! in_array( 'dgr_start_viewport_buffer', $hooked, true ) );

echo "\n" . ( 0 === $failures ? 'all checks passed' : "{$failures} check(s) failed" ) . "\n";
exit( 0 === $failures ? 0 : 1 );
