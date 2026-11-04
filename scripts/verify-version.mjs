import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function verifyVersion(root, tag) {
  const versions = ["local", "browser"].map(name => JSON.parse(readFileSync(join(root, name, "package.json"), "utf8")).version);
  if (versions[0] !== versions[1] || !/^\d+\.\d+\.\d+$/.test(versions[0]) || tag && tag !== "v" + versions[0]) {
    throw new Error("Release tag must match both app package versions.");
  }
  return versions[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(verifyVersion(dirname(dirname(fileURLToPath(import.meta.url))), process.argv[2]) + "\n"); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
