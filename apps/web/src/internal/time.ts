/**
 * Showing a time to a person.
 *
 * Everything in this system is stored and reasoned about in ISO-8601 UTC — that is a
 * correctness decision (ADR-003) and it does not change. But UTC is not what a reader in
 * San Francisco wants to look at, and the server does not know where the reader is, so the
 * conversion happens in the browser: the server emits a `<time datetime>` carrying the
 * exact instant, and the page rewrites it into the visitor's own locale.
 *
 * The original timestamp is never thrown away — it stays in `datetime` and appears on
 * hover, so a reader comparing against the agency's own records always has the exact
 * string we received.
 */

import { escapeHtml } from "../security.ts";

export interface TimeTagOptions {
  /**
   * Text to show instead of the absolute time — a relative form like "12 min ago". The
   * localized absolute time then goes on hover beside the original.
   */
  text?: string | undefined;
  /** Rendered as-is after the time, inside the same element (e.g. " · 3 units"). */
  className?: string | undefined;
}

/**
 * A `<time>` element the client-side formatter can localize.
 *
 * With scripting off, the element still reads correctly: the fallback text is either the
 * relative form or the ISO timestamp, neither of which is wrong — only less friendly.
 */
export function timeTag(iso: string, options: TimeTagOptions = {}): string {
  const safe = escapeHtml(iso);
  const relative = options.text !== undefined;
  const className = options.className ? ` class="${escapeHtml(options.className)}"` : "";
  return `<time${className} datetime="${safe}" data-rel="${relative ? "1" : "0"}" title="${safe}">${escapeHtml(
    options.text ?? iso,
  )}</time>`;
}

/**
 * The formatter, injected once per page under the CSP nonce.
 *
 * `undefined` as the locale means "whatever this browser is set to", which is the whole
 * point — the server must not guess it from an IP or an `Accept-Language` header it would
 * then have to cache against.
 */
export const LOCAL_TIME_SCRIPT = `
  (function () {
    function format(date) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "medium",
        }).format(date);
      } catch (error) {
        return date.toLocaleString();
      }
    }
    function localize(root) {
      var nodes = (root || document).querySelectorAll("time[datetime]");
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.dataset.localized === "1") continue;
        var iso = node.getAttribute("datetime");
        var date = new Date(iso);
        if (isNaN(date.getTime())) continue;
        var local = format(date);
        if (node.dataset.rel === "1") {
          // Keep "12 min ago" — it is the more useful reading — and put the exact
          // instant, in both forms, on hover.
          node.title = local + " · " + iso;
        } else {
          node.textContent = local;
          node.title = iso;
        }
        node.dataset.localized = "1";
      }
    }
    localize(document);
    document.addEventListener("DOMContentLoaded", function () {
      localize(document);
    });
  })();
`;
