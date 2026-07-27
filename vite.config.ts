import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite config: React plugin only. No additional plugins/deps
// so the build surface stays small and predictable.

/**
 * DEV PORT — deliberately NOT Vite's default 5173, which is the port every other Vite
 * project on the machine also wants. Without a fixed choice the first project to start
 * takes 5173 and the rest silently walk up to 5174, 5175… so the URL for this app changes
 * depending on what else happened to be running. Pinning it means the address is always
 * the same one.
 *
 * `strictPort` makes a clash FAIL rather than quietly move: a dev server on an unexpected
 * port is worse than one that refuses to start, because you find out by loading someone
 * else's app and wondering why your change did nothing.
 *
 * Override with PORT=… for a one-off.
 */
const DEV_PORT = Number(process.env.PORT) || 5280;
/** Preview (built output) gets its own, so `npm run preview` can run ALONGSIDE `npm run dev`
 *  — checking a production build against the live one is exactly when you want both. */
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT) || 5281;

/**
 * Is this instance served through the VM's nginx TLS proxy? `ALLOWED_HOSTS` is only set
 * there, so it doubles as the signal for the proxy-specific HMR settings below.
 */
const behindProxy = Boolean(process.env.ALLOWED_HOSTS);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: DEV_PORT,
    strictPort: true,
    // Served behind the VM's nginx (TLS). `ALLOWED_HOSTS` is a comma-separated list of
    // public hostnames; if unset, allow any host (the container only binds to localhost).
    allowedHosts: behindProxy
      ? process.env.ALLOWED_HOSTS!.split(",").map((h) => h.trim()).filter(Boolean)
      : true,
    // Behind the proxy the browser reaches the app over TLS on 443, so the HMR socket has
    // to be told to use wss on that port instead of the dev server's own. Running LOCALLY
    // there is no proxy and no TLS: those same settings would point the socket at
    // wss://localhost:443, which nothing is listening on, and hot reload would silently
    // never connect. So they apply only where they are true, and a local run keeps Vite's
    // own defaults (which already match the server it is talking to).
    hmr: behindProxy ? { protocol: "wss", clientPort: 443 } : undefined,
  },
  preview: {
    port: PREVIEW_PORT,
    strictPort: true,
  },
});
