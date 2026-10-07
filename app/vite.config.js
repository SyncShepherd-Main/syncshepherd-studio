import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    // Local stand-in for the Pages Function at /api: forward to the local Worker
    // with the dev key (must match PAGECAST_KEY in worker/.dev.vars)
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        rewrite: (p) => p.replace(/^\/api/, ""),
        headers: { "X-PageCast-Key": process.env.PAGECAST_KEY || "dev-key" },
      },
    },
  },
});
