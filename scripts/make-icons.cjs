const { app, BrowserWindow } = require("electron");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

app.whenReady().then(async () => {
  const temporary = mkdtempSync(join(tmpdir(), "sospio-icons-"));
  const window = new BrowserWindow({width: 1024, height: 1024, show: false, frame: false,
    transparent: true, webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}});
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({cancel: !request.url.startsWith("file:")}));
  try {
    for (const name of ["local", "browser"]) {
      const directory = resolve(__dirname, "..", name, "build");
      await window.loadFile(join(directory, "icon.svg"));
      const screenshot = await window.webContents.capturePage();
      const image = screenshot.resize({width: 1024, height: 1024});
      const iconset = join(temporary, name + ".iconset"); mkdirSync(iconset);
      const original = join(temporary, name + ".png"); writeFileSync(original, image.toPNG());
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          const output = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
          execFileSync("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), original, "--out", output], {stdio: "ignore"});
        }
      }
      execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(directory, "icon.icns")]);
    }
  } finally { window.destroy(); rmSync(temporary, {recursive: true, force: true}); }
  app.quit();
}).catch(error => { process.stderr.write(`Icon generation failed: ${error.message}\n`); app.exit(1); });
