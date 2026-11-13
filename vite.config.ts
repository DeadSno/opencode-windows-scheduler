import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Официальный gui()-плагин сам:
// - подключает vite-plugin-solid и компилирует Solid JSX;
// - пишет один CommonJS-бандл dist/gui-experimental.cjs;
// - держит предоставляемые приложением модули (solid-js, @opencode/plugin/gui, effect) внешними.
export default defineConfig({
  plugins: [gui({ outFile: "./gui-experimental.cjs" })],
})
