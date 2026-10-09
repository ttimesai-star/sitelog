import { defineConfig } from "vite"

// GitHub Pages serves the app from /sitelog/
export default defineConfig({
  base: process.env.SITELOG_BASE || "/sitelog/",
  build: {
    target: "es2022",
    // Two pages: the Agent Action Log (index) and the construction use case (site).
    rollupOptions: { input: { main: "index.html", site: "site.html" } },
  },
})
