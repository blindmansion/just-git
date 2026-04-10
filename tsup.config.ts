import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/server/index.ts", "src/repo/index.ts", "src/proxy/index.ts"],
	format: ["esm"],
	splitting: false,
	dts: true,
	clean: true,
	target: "es2022",
	platform: "neutral",
	minify: true,
});
