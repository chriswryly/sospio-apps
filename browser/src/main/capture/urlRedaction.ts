import type { NetworkParser } from "./providers/types";

/**
 * URL and log-line redaction for everything the harness writes to disk.
 *
 * Two call sites with different needs share one definition of "opaque" so the
 * discipline cannot drift between them: `sanitizeNetworkUrl` for the `NetworkTag`
 * records in the session JSONL, `sanitizeLogUrl` for the navigation diagnostics
 * in `harness-main.log`.
 */

export function sanitizeNetworkUrl(url: string, parser?: NetworkParser): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${redactPathname(parsed.pathname, parser?.pathSafeSegments ?? [])}`;
  } catch {
    return "unknown://invalid-url";
  }
}

/**
 * Same posture as `sanitizeNetworkUrl` — opaque path segments out, query string
 * out — with three differences that matter for a navigation log:
 *
 * - Schemes with no WHATWG origin (`file:`, `about:`) keep their scheme and path
 *   instead of being logged as `null...`.
 * - `data:` URLs collapse to their media type. The harness' own landing page is a
 *   2.4 KB `data:` URL; logging it whole was over half of one 527 KB run log.
 * - A dropped query is recorded as `?REDACTED` rather than vanishing, so the
 *   record shows that the original URL carried one.
 *
 * Sign-in flows put single-use tokens in the query string (Google's `?TL=`,
 * `?as=`), so the query goes wholesale rather than key by key.
 */
export function sanitizeLogUrl(url: string): string {
  if (!url) {
    return "(none)";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown://invalid-url";
  }
  if (parsed.protocol === "data:") {
    const [mediaType] = parsed.pathname.split(",", 1);
    return `data:${mediaType}`;
  }
  // `host` (not `hostname`) keeps the port and drops any `user:pass@` userinfo.
  const authority = parsed.href.startsWith(`${parsed.protocol}//`) ? `//${parsed.host}` : parsed.host;
  const dropped = parsed.search || parsed.hash ? "?REDACTED" : "";
  return `${parsed.protocol}${authority}${redactPathname(parsed.pathname, [])}${dropped}`;
}

const QUERY_VALUE = /([?&][A-Za-z0-9_.-]+=)[^\s&#"'\\]{16,}/g;

/**
 * Last-resort scrub applied at the single point where a log line is written.
 *
 * `sanitizeLogUrl` covers the URLs the harness interpolates deliberately, but log
 * lines also carry strings the harness did not compose — renderer console output,
 * error stacks, load-failure descriptions — and the redaction gap this closes was
 * exactly a log site added without the sanitizer. The harness' value is an
 * auditable record, so the write point refuses long query-parameter values no
 * matter which caller composed them.
 *
 * The 16-character floor is deliberately tighter than the 20 the credential-leak
 * scan looks for, and unlike that scan this covers `&key=` as well as `?key=`.
 */
export function redactQueryValues(message: string): string {
  return message.replace(QUERY_VALUE, "$1REDACTED");
}

function redactPathname(pathname: string, safeSegments: ReadonlyArray<string>): string {
  const safe = new Set(safeSegments);
  const segments = pathname.split("/");
  return segments.map((segment) => {
    if (!segment || safe.has(segment)) {
      return segment;
    }
    return isOpaquePathSegment(segment) ? "REDACTED" : segment;
  }).join("/");
}

function isOpaquePathSegment(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  if (/^[0-9a-f]{24,}$/i.test(segment)) {
    return true;
  }
  if (/^[A-Za-z0-9_-]{20,}$/.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)) {
    return true;
  }
  return false;
}
