import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkBundle } from "./check-bundle.mjs";
import { signingOptions } from "./signing.mjs";

if (process.platform !== "darwin") throw new Error("Installers must be built on macOS.");
const args = process.argv.slice(2);
if (args.some(argument => !["--arm64", "--x64"].includes(argument))) throw new Error("Only --arm64 and --x64 are supported.");
const architectures = args.length ? [...new Set(args.map(argument => argument.slice(2)))] : [process.arch];
if (architectures.some(arch => !["arm64", "x64"].includes(arch))) throw new Error("Unsupported Mac architecture.");
const directory = process.cwd();
const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
if (!["sospio-local", "sospio-browser"].includes(metadata.name)) throw new Error("Run dist from a Sospio app folder.");
rmSync(join(directory, "dist"), {recursive: true, force: true});
const bundledPackages = ["react", "react-dom", "scheduler", "@fontsource/ibm-plex-sans", "@fontsource/ibm-plex-mono"];
const licenses = bundledPackages.map(name => name + "\n\n" + readFileSync(join(directory, "node_modules", name, "LICENSE"), "utf8"));
writeFileSync(join(directory, "out/renderer/third-party-licenses.txt"), licenses.join("\n\n---\n\n"));
const signing = signingOptions(process.env);
const environment = {...process.env};
for (const name of Object.keys(environment)) {
  if (/^(?:CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) delete environment[name];
}
Object.assign(environment, signing.environment, {CSC_IDENTITY_AUTO_DISCOVERY: "false"});
process.stdout.write(signing.enabled ? "Certificate signing and notarization enabled.\n" : "No complete signing secrets: using ad-hoc signing without notarization.\n");
const builder = resolve("node_modules/electron-builder/cli.js");
const result = spawnSync(process.execPath, [builder, "--mac", "--publish", "never", ...architectures.map(arch => "--" + arch), ...signing.arguments], {stdio: "inherit", env: environment});
if (result.error || result.status !== 0) process.exit(result.status || 1);
const productName = metadata.productName;
for (const arch of architectures) {
  const application = join(directory, "dist", arch === "arm64" ? "mac-arm64" : "mac", productName + ".app");
  checkBundle(join(application, "Contents/Resources/app.asar"), directory);
}
const artifacts = readdirSync(join(directory, "dist")).filter(name => /\.(dmg|zip)$/.test(name)).sort();
const sums = artifacts.map(name => createHash("sha256").update(readFileSync(join(directory, "dist", name))).digest("hex") + "  " + name);
writeFileSync(join(directory, "dist", "SHA256SUMS.txt"), sums.join("\n") + "\n");
