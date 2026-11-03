import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {plugins: [externalizeDepsPlugin()]},
  preload: {plugins: [externalizeDepsPlugin()], build: {rollupOptions: {output: {format: "cjs", entryFileNames: "[name].cjs"}}}},
  renderer: {
    resolve: {alias: {"@sospio/cockpit": resolve("../cockpit/src/index.ts"), "@fontsource/ibm-plex-sans": resolve("node_modules/@fontsource/ibm-plex-sans"), "@fontsource/ibm-plex-mono": resolve("node_modules/@fontsource/ibm-plex-mono"), react: resolve("node_modules/react"), "react-dom": resolve("node_modules/react-dom")}, dedupe: ["react", "react-dom"]},
    server: {fs: {allow: [resolve("..")]}},
    root: resolve("src/renderer"), plugins: [react()],
  },
});
