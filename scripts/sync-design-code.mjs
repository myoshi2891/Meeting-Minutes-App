// Keep Phase 1's complete embedded src blocks identical to the implementation.
import { readFileSync, writeFileSync } from "node:fs";

const docPath = "design-local-phase1.md";
const sources = [
  "src/recording/recording-controller.ts",
  "src/api/local-saver.ts",
  "src/api/meeting-registrar.ts",
  "src/app/app.ts",
  "src/ui/recording-view.ts",
];
const original = readFileSync(docPath, "utf8");
let doc = original;
for (const path of sources) {
  const marker = `// ${path}\n`;
  const start = doc.indexOf(marker);
  if (start < 0 || doc.indexOf(marker, start + 1) >= 0) throw new Error(`expected one block for ${path}`);
  const end = doc.indexOf("\n```", start);
  if (end < 0) throw new Error(`unterminated block for ${path}`);
  const source = readFileSync(path, "utf8").trimEnd();
  doc = doc.slice(0, start) + source + doc.slice(end);
}
if (process.argv.includes("--check")) {
  if (doc !== original) throw new Error(`${docPath} has outdated embedded code`);
  process.stdout.write("embedded Phase 1 code matches src\n");
} else {
  writeFileSync(docPath, doc);
}
