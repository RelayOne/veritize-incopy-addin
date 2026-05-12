/// <reference types="vitest/config" />
import { defineConfig, type UserConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vite plugin: copy manifest.json from project root to dist/ on build so
// the .ccx packager can pick it up alongside the bundled assets.
function copyManifest(): Plugin {
  return {
    name: "copy-manifest",
    closeBundle() {
      const distDir = resolve(__dirname, "dist");
      if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, "manifest.json"),
        resolve(distDir, "manifest.json"),
      );
      // Also publish the OAuth callback HTML to dist/oauth/callback.html
      // so Cloudflare Pages can serve it from incopy.veritize.app.
      const oauthSrc = resolve(__dirname, "oauth", "callback.html");
      const oauthDistDir = resolve(distDir, "oauth");
      if (!existsSync(oauthDistDir)) mkdirSync(oauthDistDir, { recursive: true });
      copyFileSync(oauthSrc, resolve(oauthDistDir, "callback.html"));
    },
  };
}

// Vite config for the Adobe InCopy UXP plugin.
//
// `npm run dev` runs the Vite dev server at https://localhost:3000 for
// in-panel hot-reload via the UXP Developer Tool (UDT).  Sideload the
// plugin in UDT pointed at this directory; UDT injects the dev URL.
//
// `npm run build` outputs static assets to dist/.  The CI workflow
// pushes dist/ to Cloudflare Pages at incopy.veritize.app (which only
// hosts the OAuth callback page; the plugin itself ships as a .ccx
// installed via UDT or Adobe Exchange).

const config: UserConfig = {
  plugins: [react(), copyManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
      },
    },
  },
  server: {
    port: 3000,
    host: "localhost",
  },
  test: {
    environment: "happy-dom",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/__tests__/**", "src/**/*.d.ts"],
    },
  },
};

export default defineConfig(config);
