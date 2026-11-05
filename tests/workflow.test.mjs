import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "local/package.json"));
const yaml = require("js-yaml");
const workflow = yaml.load(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
test("workflow builds both apps and architectures, but publishes only tag-triggered drafts", () => {
  assert.deepEqual(workflow.on.push.tags, ["v*"]); assert.ok("workflow_dispatch" in workflow.on);
  assert.deepEqual(workflow.permissions, {contents: "read"});
  assert.deepEqual(workflow.jobs.build.strategy.matrix.app, ["local", "browser"]);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.platform, [{runner: "macos-latest", arch: "arm64"}, {runner: "macos-15-intel", arch: "x64"}]);
  const release = workflow.jobs.release;
  assert.deepEqual(release.permissions, {contents: "write"}); assert.equal(release.needs, "build");
  assert.match(release.if, /github.event_name == 'push'/); assert.match(release.if, /refs\/tags\/v/);
  assert.match(release.steps.at(-1).run, /--draft/); assert.match(release.steps.at(-1).run, /--verify-tag/);
  assert.match(release.steps.at(-1).run, /SHA256SUMS\.txt/);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  }
});
test("workflow runs offline checks before either installer build and gates certificate signing", () => {
  const steps = workflow.jobs.build.steps;
  const checks = steps.findIndex(step => step.name === "Check types and tests");
  const scan = steps.findIndex(step => step.name === "Check release sources and imports");
  const builds = steps.filter(step => step.run?.startsWith("npm run dist"));
  assert.equal(builds.length, 2);
  for (const build of builds) { assert.ok(steps.indexOf(build) > checks); assert.ok(steps.indexOf(build) > scan); }
  const signed = builds.find(step => step.if.includes("== 'true'"));
  const unsigned = builds.find(step => step.if.includes("!= 'true'"));
  assert.ok(signed.env.APPLE_CERTIFICATE); assert.ok(signed.env.APPLE_TEAM_ID); assert.equal(unsigned.env, undefined);
  for (const command of ["npm run typecheck", "npm test", "npm run test:leaks"]) assert.ok(steps[checks].run.includes(command));
});
test("builder configs package only release outputs, use distinct identities, and default to ad-hoc signing", () => {
  const ids = new Set();
  for (const name of ["local", "browser"]) {
    const config = yaml.load(readFileSync(join(root, name, "electron-builder.yml"), "utf8"));
    ids.add(config.appId); assert.match(config.appId, /^net\.axrlab\.sospio\.(chat|browser)$/);
    assert.equal(config.mac.identity, "-"); assert.equal(config.mac.hardenedRuntime, false); assert.equal(config.mac.notarize, false);
    assert.deepEqual(config.mac.target, ["dmg", "zip"]); assert.equal(config.publish, null);
    assert.ok(config.artifactName.includes("${version}")); assert.ok(config.artifactName.includes("${arch}"));
    assert.equal(config.asar, true); assert.ok(config.files.includes("out/**/*"));
    assert.ok(config.files.includes("!**/*.map")); assert.ok(config.files.includes("!**/.env*"));
    const metadata = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
    assert.equal(metadata.productName, config.productName); assert.equal(metadata.version, "0.1.1");
    assert.ok(metadata.devDependencies.electron); assert.equal(metadata.dependencies.electron, undefined);
  }
  assert.equal(ids.size, 2);
});

test("both release apps use the same reviewed Electron 45 runtime in their manifests and lockfiles", () => {
  for (const name of ["local", "browser"]) {
    const metadata = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, name, "package-lock.json"), "utf8"));
    assert.equal(metadata.devDependencies.electron, "^45.2.2");
    assert.equal(lock.packages[""].devDependencies.electron, metadata.devDependencies.electron);
    assert.equal(lock.packages["node_modules/electron"].version, "45.2.2");
    assert.equal(lock.packages["node_modules/electron"].dev, true);
  }
});
