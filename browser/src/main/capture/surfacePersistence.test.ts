/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  describePersistence,
  readSurfacePersistence,
  surfacePersistedScript,
  SURFACE_PERSISTENCE_DELAY_MS,
} from "./surfacePersistence";

describe("surface persistence", () => {
  it("resolves present for a surface that survives the delay", async () => {
    document.body.innerHTML = '<div id="rsh-surface"></div>';
    const result = await eval(surfacePersistedScript("#rsh-surface", 5));
    expect(result).toEqual({ present: true, checked_after_ms: 5 });
  });

  /**
   * The case the check exists for: injection succeeded, then the page discarded the node. The
   * old probes verified only at injection time and would have reported this as demonstrated.
   */
  it("resolves absent for a surface removed after injection", async () => {
    document.body.innerHTML = '<div id="rsh-surface"></div>';
    setTimeout(() => document.getElementById("rsh-surface")?.remove(), 1);
    const result = await eval(surfacePersistedScript("#rsh-surface", 20));
    expect(result).toEqual({ present: false, checked_after_ms: 20 });
  });

  it("serializes the selector as data rather than source", () => {
    const hostile = '#x"]; globalThis.compromised = true; //';
    expect(surfacePersistedScript(hostile)).toContain(JSON.stringify(hostile));
    expect(surfacePersistedScript("#a")).toContain(String(SURFACE_PERSISTENCE_DELAY_MS));
  });

  it("treats a malformed page result as not present", () => {
    expect(readSurfacePersistence(undefined, 900)).toEqual({ present: false, checked_after_ms: 900 });
    expect(readSurfacePersistence({ present: "yes" }, 900)).toEqual({ present: false, checked_after_ms: 900 });
    expect(readSurfacePersistence({ present: true, checked_after_ms: 10 }, 900)).toEqual({
      present: true,
      checked_after_ms: 10,
    });
  });

  it("describes the outcome in terms of user visibility", () => {
    expect(describePersistence({ present: false, checked_after_ms: 1200 })).toContain("not user-visible");
    expect(describePersistence({ present: true, checked_after_ms: 1200 })).toContain("still present");
  });
});
