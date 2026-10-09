import { defineConfig } from "vite"

// GitHub Pages serves the app from /sitelog/
export default defineConfig({
  base: process.env.SITELOG_BASE || "/sitelog/",
  build: { target: "es2022" },
})
