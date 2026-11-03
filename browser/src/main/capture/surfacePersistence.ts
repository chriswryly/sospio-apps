/**
 * Post-injection persistence verification.
 *
 * Every governor surface probe verified itself at the *instant* of injection — insert the node,
 * immediately re-query it, report `demonstrated`. On a framework-driven chat surface that is not
 * enough: a node inserted outside the framework's tree can be discarded on the next render, so a
 * probe could truthfully report `demonstrated` for a surface the user never saw. That gap is the
 * difference between "the script ran" and "the governor was present", and only the second is
 * what E_b's capability profile is supposed to mean.
 *
 * This re-queries after a delay so a surface that does not survive is recorded as a failure
 * rather than a demonstration.
 */

/** Long enough to outlast a render pass, short enough not to stall a probe sequence. */
export const SURFACE_PERSISTENCE_DELAY_MS = 1200;

export type SurfacePersistence = {
  present: boolean;
  checked_after_ms: number;
};

/**
 * Builds a script that resolves once the delay has elapsed. `selector` is embedded via
 * JSON.stringify, so callers pass a plain CSS selector rather than pre-escaped source.
 */
export function surfacePersistedScript(
  selector: string,
  delayMs: number = SURFACE_PERSISTENCE_DELAY_MS,
): string {
  return `(() => new Promise((resolve) => {
    const selector = ${JSON.stringify(selector)};
    const delay = ${JSON.stringify(delayMs)};
    setTimeout(() => {
      let present = false;
      try {
        present = Boolean(document.querySelector(selector));
      } catch {
        present = false;
      }
      resolve({ present, checked_after_ms: delay });
    }, delay);
  }))()`;
}

/** Normalizes an untrusted page result into the typed shape. */
export function readSurfacePersistence(result: unknown, delayMs: number): SurfacePersistence {
  const record = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return {
    present: record.present === true,
    checked_after_ms: typeof record.checked_after_ms === "number" ? record.checked_after_ms : delayMs,
  };
}

/** Probe-detail suffix, so a record says how its persistence claim was established. */
export function describePersistence(persistence: SurfacePersistence): string {
  return persistence.present
    ? `surface still present ${persistence.checked_after_ms}ms after injection`
    : `surface was removed within ${persistence.checked_after_ms}ms of injection (not user-visible)`;
}
