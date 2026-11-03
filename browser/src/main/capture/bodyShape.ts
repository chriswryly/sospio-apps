/**
 * Summarise the *shape* of a JSON request body — key paths and value types only, never values.
 *
 * Why this exists: when a provider changes its request envelope, the only symptom is
 * `completion request was not a plain user-text turn`, which says a prompt could not be found
 * but not what the body actually looked like. That is what blocked the browser Grok pass — every
 * armed mechanism failed to bind because the user turn was never registered, and the record
 * gave no way to tell which key now carries the prompt. Guessing at provider envelopes from the
 * outside is slow and wrong; the body can describe itself.
 *
 * The harness must never persist raw request or response bodies (see README and
 * `credential_leak.test.ts`). So this emits **no string values at all** — only key paths, the
 * type at each path, and string lengths. A key name is structure; a key value is content.
 */

const MAX_PATHS = 40;
const MAX_DEPTH = 6;

export function describeBodyShape(rawBody: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return `non-json body (${rawBody.length} chars)`;
  }
  const state: WalkState = { paths: [], truncated: false };
  walk(payload, "", 0, state);
  // Say so when the view is partial. A diagnostic whose job is to describe an unfamiliar
  // envelope must not silently truncate — a reader would take a clipped shape for the whole one
  // and conclude the key they are looking for is absent.
  return state.paths.join(" ") + (state.truncated ? " …(truncated)" : "");
}

type WalkState = { paths: string[]; truncated: boolean };

function walk(value: unknown, path: string, depth: number, out: WalkState): void {
  if (out.paths.length >= MAX_PATHS) {
    out.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) {
    out.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    out.paths.push(`${path || "$"}[${value.length}]`);
    // One representative element is enough to show the element shape.
    if (value.length > 0) {
      walk(value[0], `${path}[0]`, depth + 1, out);
    }
    return;
  }
  if (value === null) {
    out.paths.push(`${path}=null`);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (let i = 0; i < entries.length; i += 1) {
      const [key, nested] = entries[i];
      walk(nested, path ? `${path}.${key}` : key, depth + 1, out);
      if (out.paths.length >= MAX_PATHS && i < entries.length - 1) {
        out.truncated = true;
        return;
      }
    }
    return;
  }
  if (typeof value === "string") {
    // Length only. The value may be the user's prompt, a token, or a credential.
    out.paths.push(`${path}:str(${value.length})`);
    return;
  }
  out.paths.push(`${path}:${typeof value}`);
}
