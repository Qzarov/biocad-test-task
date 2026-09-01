import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // SSE needs the proxy to stay unbuffered, which Vite's http-proxy does by default
      "/api": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
