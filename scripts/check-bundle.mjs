import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanText } from "./release-scan.mjs";

const banned = /(^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|scripts|\.env[^/]*)(?:\/|$)|\.(?:map|ts|tsx)$|\.(?:test|spec)\.[^/]+$/i;
export function checkBundleEntries(entries, packages) {
  const errors = [];
  const roots = new Set(packages.map(name => "node_modules/" + name));
  for (const raw of entries) {
    const name = raw.replace(/^\//, "");
    if (!name || name.includes("\\") || name.split("/").includes("..") || banned.test(name)) {
      errors.push(`Disallowed bundle entry: ${name}`); continue;
    }
    const dependency = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(name)?.[1];
    if (["package.json", "LICENSE"].includes(name) || /^out\/(main|preload|renderer)\//.test(name) ||
      dependency && roots.has(dependency)) continue;
    errors.push(`Unexpected bundle entry: ${name}`);
  }
  for (const name of ["package.json", "LICENSE", "out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
    if (!entries.includes("/" + name) && !entries.includes(name)) errors.push(`Missing bundle entry: ${name}`);
  }
  return errors;
}

export function checkBundle(archive, appDirectory) {
  const require = createRequire(join(resolve(appDirectory), "package.json"));
  const asar = require("@electron/asar");
  asar.uncache(archive);
  const lock = JSON.parse(readFileSync(join(appDirectory, "package-lock.json"), "utf8"));
  const packages = Object.entries(lock.packages).filter(([name, value]) => name.startsWith("node_modules/") && !value.dev)
    .map(([name]) => name.slice("node_modules/".length));
  const entries = asar.listPackage(archive).filter(name => {
    const entry = asar.statFile(archive, name.replace(/^\//, ""), false);
    if (entry.link) throw new Error(`Bundle links are not allowed: ${name}`);
    return !entry.files;
  });
  const errors = checkBundleEntries(entries, packages);
  if (errors.length) throw new Error(errors.join("\n"));
  const temporary = mkdtempSync(join(tmpdir(), "sospio-bundle-"));
  let scanned = 0;
  try {
    asar.extractAll(archive, temporary);
    function visit(directory) {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry), name = relative(temporary, path);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { errors.push(`Bundle links are not allowed: ${name}`); continue; }
        if (stat.isDirectory()) { visit(path); continue; }
        scanned++;
        for (const reason of [...scanText(name), ...scanText(readFileSync(path, "utf8"), "bundle/" + name)]) errors.push(`${name}: ${reason}`);
      }
    }
    visit(temporary);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(`Bundle allow-list and leak scan passed: ${entries.length} entries, ${scanned} unpacked files.\n`);
  for (const entry of entries) process.stdout.write(entry + "\n");
  return {entries: entries.length, scanned};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: check-bundle.mjs <app.asar> <app-directory>");
    checkBundle(resolve(process.argv[2]), resolve(process.argv[3]));
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
