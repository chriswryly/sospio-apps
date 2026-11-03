import {resolve} from "node:path";
import {defineConfig} from "vitest/config";
export default defineConfig({
  resolve:{alias:{"@sospio/cockpit":resolve("../cockpit/src/index.ts"), "@fontsource/ibm-plex-sans": resolve("node_modules/@fontsource/ibm-plex-sans"), "@fontsource/ibm-plex-mono": resolve("node_modules/@fontsource/ibm-plex-mono")},dedupe:["react","react-dom"]},
  server: {fs: {allow: [resolve("..")]}},
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "../shared/**/*.test.ts", "../records/**/*.test.ts", "../cockpit/src/**/*.test.ts", "../cockpit/src/**/*.test.tsx"],
    environmentMatchGlobs: [["../cockpit/**/*.test.tsx", "jsdom"]],
  },
});
