import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkBundle, checkBundleEntries } from "../scripts/check-bundle.mjs";
import { signingOptions } from "../scripts/signing.mjs";
import { verifyVersion } from "../scripts/verify-version.mjs";

const baseline = ["/package.json", "/LICENSE", "/out/main/index.js", "/out/preload/index.cjs", "/out/renderer/index.html"];
test("bundle allow-list admits only built outputs and declared production packages", () => {
  assert.deepEqual(checkBundleEntries([...baseline, "/out/renderer/assets/icon.png", "/node_modules/react/index.js"], ["react"]), []);
  for (const name of ["src/main.js", "out/main/index.js.map", "out/main/debug.test.ts", "out/main/tests/fixture.js",
    "out/renderer/fixtures/data.json", "out/main/.env.local", "scripts/start.js", "node_modules/unknown/index.js",
    "node_modules/react/tests/check.js", "node_modules/react/scripts/build.js", "node_modules/react/node_modules/unknown/index.js",
    "out/main/fixture.test.js", "../escape", "README.md"]) {
    assert.ok(checkBundleEntries([...baseline, "/" + name], ["react"]).length > 0, name);
  }
  assert.ok(checkBundleEntries([], []).some(error => error.includes("LICENSE")));
});
test("real archives are unpacked and scanned, while unexpected files and links fail closed", async () => {
  const appDirectory = fileURLToPath(new URL("../local", import.meta.url));
  const require = createRequire(join(appDirectory, "package.json")), asar = require("@electron/asar");
  const root = mkdtempSync(join(tmpdir(), "sospio-archive-")), source = join(root, "files");
  try {
    for (const name of baseline) {
      const path = join(source, name); mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, "fixture");
    }
    const archive = join(root, "app.asar");
    await asar.createPackage(source, archive); assert.equal(checkBundle(archive, appDirectory).scanned, 5);
    writeFileSync(join(source, "out/main/index.js"), ["l", "una"].join(""));
    await asar.createPackage(source, archive); assert.throws(() => checkBundle(archive, appDirectory), /private monitor term/);
    writeFileSync(join(source, "out/main/index.js"), "fixture");
    writeFileSync(join(source, "out/main/index.js.map"), "fixture");
    await asar.createPackage(source, archive); assert.throws(() => checkBundle(archive, appDirectory), /Disallowed bundle entry/);
    rmSync(join(source, "out/main/index.js.map"));
    symlinkSync("index.js", join(source, "out/main/link.js"));
    await asar.createPackage(source, archive); assert.throws(() => checkBundle(archive, appDirectory), /Bundle links are not allowed/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test("signing stays off unless every required secret exists", () => {
  const env = {APPLE_CERTIFICATE: "fixture certificate", APPLE_CERTIFICATE_PASSWORD: "fixture password",
    APPLE_SIGNING_IDENTITY: "fixture identity", APPLE_ID: "fixture account", APPLE_APP_SPECIFIC_PASSWORD: "fixture password", APPLE_TEAM_ID: "fixture team"};
  assert.equal(signingOptions({}).enabled, false);
  for (const name of Object.keys(env)) assert.deepEqual(signingOptions({...env, [name]: ""}), {enabled: false, environment: {}, arguments: []});
  const signed = signingOptions(env);
  assert.equal(signed.enabled, true); assert.equal(signed.environment.CSC_LINK, env.APPLE_CERTIFICATE);
  assert.ok(signed.arguments.includes("-c.mac.hardenedRuntime=true"));
  assert.ok(signed.arguments.includes("-c.mac.notarize=true"));
});
test("release tag must match both app versions, including manual version consistency", () => {
  const root = mkdtempSync(join(tmpdir(), "sospio-versions-"));
  try {
    for (const name of ["local", "browser"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "package.json"), JSON.stringify({version: "0.1.0"})); }
    assert.equal(verifyVersion(root, "v0.1.0"), "0.1.0"); assert.equal(verifyVersion(root), "0.1.0");
    assert.throws(() => verifyVersion(root, "v0.2.0"));
    writeFileSync(join(root, "browser", "package.json"), JSON.stringify({version: "0.2.0"}));
    assert.throws(() => verifyVersion(root, "v0.1.0")); assert.throws(() => verifyVersion(root));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
