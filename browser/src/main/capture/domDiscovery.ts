/**
 * Conversation-DOM discovery.
 *
 * Characterizing a new provider's surface currently means guessing selectors and watching a
 * probe fail. This reports the page's actual attribute vocabulary and its repeated turn-shaped
 * structures so a `providerDomSelectors` entry can be written from evidence.
 *
 * Privacy: this runs against a real logged-in session, so it reports STRUCTURE ONLY — tag names,
 * attribute names, counts, and text *lengths*. Attribute values are included because selectors
 * are built from them, but they are truncated hard and any value long enough to be prose is
 * dropped. No conversation text is ever returned.
 */

export type DomDiscoveryReport = {
  url_host: string;
  element_count: number;
  data_attributes: Array<{ name: string; count: number; values: string[] }>;
  test_ids: Array<{ value: string; count: number }>;
  roles: Array<{ value: string; count: number }>;
  repeated_class_tokens: Array<{ token: string; count: number }>;
  turn_candidates: Array<{
    selector: string;
    count: number;
    text_lengths: number[];
    depth: number;
  }>;
};

const MAX_ATTR_VALUE_LENGTH = 40;
const MAX_SAMPLES = 8;
const MAX_ROWS = 25;

export function describeConversationDomScript(): string {
  return `(() => {
  const MAX_ATTR_VALUE_LENGTH = ${MAX_ATTR_VALUE_LENGTH};
  const MAX_SAMPLES = ${MAX_SAMPLES};
  const MAX_ROWS = ${MAX_ROWS};

  const all = Array.from(document.querySelectorAll("*"));

  // A value that is long, or contains whitespace runs, is likelier to be content than a token.
  function safeValue(value) {
    const text = String(value == null ? "" : value);
    if (!text || text.length > MAX_ATTR_VALUE_LENGTH) return null;
    if (/\\s{2,}/.test(text)) return null;
    return text;
  }

  function tally(pairs) {
    const map = new Map();
    for (const [key, sample] of pairs) {
      let entry = map.get(key);
      if (!entry) {
        entry = { count: 0, values: new Set() };
        map.set(key, entry);
      }
      entry.count += 1;
      if (sample !== null && entry.values.size < MAX_SAMPLES) entry.values.add(sample);
    }
    return map;
  }

  const dataPairs = [];
  const testIdPairs = [];
  const rolePairs = [];
  const classPairs = [];
  for (const element of all) {
    for (const attr of element.attributes) {
      if (!attr.name.startsWith("data-")) continue;
      dataPairs.push([attr.name, safeValue(attr.value)]);
      if (attr.name === "data-testid") testIdPairs.push([safeValue(attr.value) || "<omitted>", null]);
    }
    const role = element.getAttribute("role");
    if (role) rolePairs.push([role, null]);
    if (typeof element.className === "string") {
      for (const token of element.className.split(/\\s+/)) {
        if (token) classPairs.push([token, null]);
      }
    }
  }

  function rows(map, keyName) {
    return Array.from(map.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_ROWS)
      .map(([key, entry]) => {
        const row = { count: entry.count };
        row[keyName] = key;
        if (entry.values.size) row.values = Array.from(entry.values);
        return row;
      });
  }

  // Turn candidates: elements sharing a structural signature that repeat 2+ times and each
  // carry real text. Conversation turns are the dominant repeated text block on a chat page.
  const signatures = new Map();
  for (const element of all) {
    const text = (element.textContent || "").trim();
    if (text.length < 20) continue;
    const attrs = Array.from(element.attributes)
      .filter((a) => a.name.startsWith("data-") || a.name === "role")
      .map((a) => {
        const value = safeValue(a.value);
        return value === null ? "[" + a.name + "]" : "[" + a.name + '="' + value + '"]';
      })
      .sort()
      .join("");
    if (!attrs) continue;
    const selector = element.tagName.toLowerCase() + attrs;
    let depth = 0;
    for (let node = element; node; node = node.parentElement) depth += 1;
    let entry = signatures.get(selector);
    if (!entry) {
      entry = { count: 0, text_lengths: [], depth };
      signatures.set(selector, entry);
    }
    entry.count += 1;
    if (entry.text_lengths.length < MAX_SAMPLES) entry.text_lengths.push(text.length);
  }

  const turn_candidates = Array.from(signatures.entries())
    .filter(([, entry]) => entry.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].depth - a[1].depth)
    .slice(0, MAX_ROWS)
    .map(([selector, entry]) => ({
      selector,
      count: entry.count,
      text_lengths: entry.text_lengths,
      depth: entry.depth,
    }));

  return {
    url_host: location.hostname,
    element_count: all.length,
    data_attributes: rows(tally(dataPairs), "name"),
    test_ids: rows(tally(testIdPairs), "value").map((row) => ({ value: row.value, count: row.count })),
    roles: rows(tally(rolePairs), "value").map((row) => ({ value: row.value, count: row.count })),
    repeated_class_tokens: rows(tally(classPairs), "token")
      .filter((row) => row.count >= 3)
      .map((row) => ({ token: row.token, count: row.count })),
    turn_candidates,
  };
})()`;
}
