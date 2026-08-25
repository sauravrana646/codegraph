import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(__dirname, "dist", "extension.js");

mkdirSync(path.join(__dirname, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(__dirname, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});

cpSync(
  path.join(__dirname, "..", "..", "packages", "language-intelligence", "python_symbol_parser.py"),
  path.join(__dirname, "python_symbol_parser.py")
);
cpSync(
  path.join(__dirname, "..", "..", "packages", "language-intelligence", "go_symbol_parser.go"),
  path.join(__dirname, "go_symbol_parser.go")
);
cpSync(
  path.join(__dirname, "..", "..", "packages", "language-intelligence", "go.mod"),
  path.join(__dirname, "go.mod")
);

console.log(`Bundled extension -> ${outfile}`);
console.log("Copied python_symbol_parser.py and go_symbol_parser.go beside extension package root");
