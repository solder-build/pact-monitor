import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served under /scorecard/ on pactnetwork.io. Keep aligned with
// <BrowserRouter basename="/scorecard"> in App.tsx.
export default defineConfig({
  base: "/scorecard/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.BACKEND_PORT || "3001"}`,
      "/health": `http://localhost:${process.env.BACKEND_PORT || "3001"}`,
    },
  },
});
