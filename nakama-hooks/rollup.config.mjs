import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";

export default {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "es",
    sourcemap: false,
  },
  plugins: [
    resolve({ extensions: [".ts", ".js"], browser: true }),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
  ],
};
