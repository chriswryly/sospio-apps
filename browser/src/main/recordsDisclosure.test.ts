import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { recordsInfo } from "../../../records/recordsConfig";
import { recordsSummary } from "../../../records/disclosure";

it("discloses browser ED once by default under the live remote gate", () => {
  const env = {};
  const text = recordsSummary(recordsInfo("computer", env, false, true));
  expect(text.split("Sospio also checks whether")).toHaveLength(2);
  const off = recordsInfo("computer", {...env, RSH_EMOTIONAL_DEPENDENCE: "0"}, false, true);
  expect(JSON.stringify(off)).toBe(JSON.stringify(recordsInfo("computer", env)));
  expect(recordsSummary(off)).not.toContain("emotional support");
  expect(readFileSync(new URL("./index.ts", import.meta.url), "utf8")).toContain('recordsInfo("computer", process.env, false, true)');
});
