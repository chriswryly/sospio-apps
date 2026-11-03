import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {alias: {"@sospio/cockpit": resolve("../cockpit/src/index.ts"), "@fontsource/ibm-plex-sans": resolve("node_modules/@fontsource/ibm-plex-sans"), "@fontsource/ibm-plex-mono": resolve("node_modules/@fontsource/ibm-plex-mono"), react: resolve("node_modules/react"), "react-dom": resolve("node_modules/react-dom")}, dedupe: ["react", "react-dom"]},
  server: {fs: {allow: [resolve("..")]}},
  test: {environmentMatchGlobs: [["../cockpit/**/*.test.tsx", "jsdom"]], include: ["src/**/*.test.{ts,tsx}", "../shared/**/*.test.ts", "../records/**/*.test.ts", "../cockpit/src/**/*.test.{ts,tsx}"], poolOptions: {forks: {maxForks: 2, minForks: 1}}},
});
