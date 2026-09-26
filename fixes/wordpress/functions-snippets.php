<?php
/**
 * Baseline mobile + SEO repair snippets for a WordPress child theme.
 *
 * Paste into the CHILD theme's functions.php (never the parent — a parent
 * theme update overwrites it). Each function is namespaced with a dgr_ prefix
 * and guarded with function_exists(), so the block is safe to paste twice and
 * safe to remove wholesale if you need to roll back.
 *
 * Everything here is either a no-op when the theme already does the right
 * thing, or a correction that only fires when it detects the defect. The
 * site-specific fixes come from the audit report; this is the layer that does
 * not need it.
 *
 * Requires PHP 7.4+.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/* -------------------------------------------------------------------------
 * 1. Load the responsive repair stylesheet last so it wins specificity ties.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_enqueue_responsive_repair' ) ) {
	function dgr_enqueue_responsive_repair() {
		$relative = '/dgr-responsive-repair.css';
		$path     = get_stylesheet_directory() . $relative;
		$uri      = get_stylesheet_directory_uri() . $relative;

		if ( ! file_exists( $path ) ) {
			return;
		}

		wp_enqueue_style(
			'dgr-responsive-repair',
			$uri,
			array(),
			// filemtime busts the cache on every edit, so you never debug a
			// stale stylesheet.
			(string) filemtime( $path )
		);
	}
	// Priority 999: after the theme and after page-builder stylesheets.
	add_action( 'wp_enqueue_scripts', 'dgr_enqueue_responsive_repair', 999 );
}

/* -------------------------------------------------------------------------
 * 2. Give wide tables their own scroll container.
 *
 * CSS cannot introduce an element, and `display: block` on a <table> breaks
 * column alignment, so the wrapper has to be added server-side.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_wrap_content_tables' ) ) {
	function dgr_wrap_content_tables( $content ) {
		if ( is_admin() || false === stripos( $content, '<table' ) ) {
			return $content;
		}

		return preg_replace_callback(
			'#<table\b[^>]*>.*?</table>#is',
			static function ( $matches ) {
				return '<div class="dgr-table-scroll" role="region" aria-label="Table, scrollable" tabindex="0">'
					. $matches[0] . '</div>';
			},
			$content
		);
	}
	add_filter( 'the_content', 'dgr_wrap_content_tables', 20 );
}

/* -------------------------------------------------------------------------
 * 3. Declare the language and region.
 *
 * Fixes a missing or bare `lang` attribute. Change the locale if the site is
 * not South African.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_language_attributes' ) ) {
	function dgr_language_attributes( $output ) {
		if ( false !== stripos( $output, 'lang=' ) ) {
			return $output;
		}

		return trim( $output . ' lang="en-ZA"' );
	}
	add_filter( 'language_attributes', 'dgr_language_attributes' );
}

/* -------------------------------------------------------------------------
 * 4. Correct a broken viewport meta tag.
 *
 * PREFERRED FIX: copy the parent theme's header.php into the child theme and
 * correct the tag there. This output filter is the fallback for themes and
 * builders that emit the tag from somewhere you cannot reach.
 *
 * It only rewrites a tag that is actually wrong (fixed width, or zoom
 * disabled), and leaves a correct one alone.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_fix_viewport_meta' ) ) {
	function dgr_fix_viewport_meta( $html ) {
		if ( false === stripos( $html, 'name="viewport"' ) && false === stripos( $html, "name='viewport'" ) ) {
			return $html;
		}

		return preg_replace_callback(
			'#<meta[^>]+name=["\']viewport["\'][^>]*>#i',
			static function ( $matches ) {
				$tag = $matches[0];

				$fixed_width  = ! preg_match( '/width\s*=\s*device-width/i', $tag );
				$zoom_blocked = (bool) preg_match( '/user-scalable\s*=\s*(no|0)/i', $tag )
					|| (bool) preg_match( '/maximum-scale\s*=\s*(1(\.0+)?|0?\.\d+)\b/i', $tag );

				if ( ! $fixed_width && ! $zoom_blocked ) {
					return $tag;
				}

				return '<meta name="viewport" content="width=device-width, initial-scale=1">';
			},
			$html
		);
	}
}

if ( ! function_exists( 'dgr_start_viewport_buffer' ) ) {
	function dgr_start_viewport_buffer() {
		if ( is_admin() || ( defined( 'DOING_AJAX' ) && DOING_AJAX ) ) {
			return;
		}
		ob_start( 'dgr_fix_viewport_meta' );
	}
	// Commented out by default: only switch it on if the audit reports a
	// viewport finding you cannot fix in header.php. Buffering the whole
	// response has a cost, so prefer the direct edit.
	// add_action( 'template_redirect', 'dgr_start_viewport_buffer', 1 );
}

/* -------------------------------------------------------------------------
 * 5. Lazy-load below-the-fold images, but never the first one.
 *
 * Lazy-loading the LCP image delays it, which is the opposite of what you
 * want. Core already handles editor images; this covers hard-coded markup
 * from page builders.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_tune_image_loading' ) ) {
	function dgr_tune_image_loading( $content ) {
		if ( is_admin() || false === stripos( $content, '<img' ) ) {
			return $content;
		}

		$seen = 0;

		return preg_replace_callback(
			'#<img\b[^>]*>#i',
			static function ( $matches ) use ( &$seen ) {
				$tag = $matches[0];
				$seen++;

				if ( 1 === $seen ) {
					// First image is the likely LCP candidate: load it eagerly
					// and at high priority.
					$tag = preg_replace( '#\s+loading=["\']lazy["\']#i', '', $tag );
					if ( ! preg_match( '/fetchpriority\s*=/i', $tag ) ) {
						$tag = preg_replace( '#<img\b#i', '<img fetchpriority="high"', $tag, 1 );
					}
					return $tag;
				}

				if ( ! preg_match( '/loading\s*=/i', $tag ) ) {
					$tag = preg_replace( '#<img\b#i', '<img loading="lazy"', $tag, 1 );
				}
				if ( ! preg_match( '/decoding\s*=/i', $tag ) ) {
					$tag = preg_replace( '#<img\b#i', '<img decoding="async"', $tag, 1 );
				}

				return $tag;
			},
			$content
		);
	}
	add_filter( 'the_content', 'dgr_tune_image_loading', 25 );
}

/* -------------------------------------------------------------------------
 * 6. LocalBusiness structured data.
 *
 * Emitted once, on the front page only, so it does not compete with per-page
 * schema from an SEO plugin. Override any value with the dgr_business_schema
 * filter rather than editing this function.
 *
 * >> REPLACE EVERY PLACEHOLDER BELOW WITH REAL DETAIL. Schema asserting
 * >> facts that are wrong is worse than no schema at all.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_business_schema' ) ) {
	function dgr_business_schema() {
		if ( ! is_front_page() ) {
			return;
		}

		$schema = array(
			'@context'    => 'https://schema.org',
			'@type'       => 'LocalBusiness',
			'@id'         => home_url( '/#business' ),
			'name'        => get_bloginfo( 'name' ),
			'description' => get_bloginfo( 'description' ),
			'url'         => home_url( '/' ),
			'logo'        => '',   // https://example.com/logo.png
			'image'       => '',   // https://example.com/premises.jpg
			'telephone'   => '',   // +27 11 000 0000
			'email'       => '',
			'address'     => array(
				'@type'           => 'PostalAddress',
				'streetAddress'   => '',
				'addressLocality' => '',
				'addressRegion'   => '',
				'postalCode'      => '',
				'addressCountry'  => 'ZA',
			),
			'areaServed'  => array(),   // e.g. array( 'South Africa', 'Botswana' )
			'openingHoursSpecification' => array(
				array(
					'@type'     => 'OpeningHoursSpecification',
					'dayOfWeek' => array( 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday' ),
					'opens'     => '08:00',
					'closes'    => '17:00',
				),
			),
			'sameAs'      => array(),   // social profile URLs
		);

		/**
		 * Filter the business schema before it is printed.
		 *
		 * @param array $schema
		 */
		$schema = apply_filters( 'dgr_business_schema', $schema );

		// Drop empty values so the markup never asserts a blank fact.
		$schema = dgr_strip_empty( $schema );

		echo "\n<script type=\"application/ld+json\">"
			. wp_json_encode( $schema, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE )
			. "</script>\n";
	}
	add_action( 'wp_head', 'dgr_business_schema', 20 );
}

if ( ! function_exists( 'dgr_strip_empty' ) ) {
	function dgr_strip_empty( $value ) {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$out = array();
		foreach ( $value as $key => $item ) {
			$item = dgr_strip_empty( $item );
			if ( '' === $item || array() === $item || null === $item ) {
				continue;
			}
			$out[ $key ] = $item;
		}

		return $out;
	}
}

/* -------------------------------------------------------------------------
 * 7. Preload the LCP image.
 *
 * Fill in the URL the audit names as the LCP element. Leave empty to skip —
 * preloading the wrong asset makes things slower, not faster.
 * ---------------------------------------------------------------------- */
if ( ! function_exists( 'dgr_preload_lcp_image' ) ) {
	function dgr_preload_lcp_image() {
		if ( ! is_front_page() ) {
			return;
		}

		$lcp_image = '';   // e.g. get_stylesheet_directory_uri() . '/images/hero-1200.webp'

		if ( '' === $lcp_image ) {
			return;
		}

		printf(
			"\n<link rel=\"preload\" as=\"image\" href=\"%s\" fetchpriority=\"high\">\n",
			esc_url( $lcp_image )
		);
	}
	add_action( 'wp_head', 'dgr_preload_lcp_image', 1 );
}
