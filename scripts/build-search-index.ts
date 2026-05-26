import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SearchPage = {
  title: string;
  description: string;
  route: string;
  sourcePath: string;
  markdown: string;
};

const docsflareDir = process.env.DOCSFLARE_OUTPUT_DIR ? path.resolve(process.env.DOCSFLARE_OUTPUT_DIR) : path.join(process.cwd(), ".docsflare");
const outputDir = path.join(docsflareDir, "search");
const { content } = await import(pathToFileURL(path.join(docsflareDir, "content.ts")).href);
const pages = content.pages as readonly SearchPage[];

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const page of pages) {
  const filename = `${page.route.replace(/^\/$/, "index").replace(/^\//, "").replace(/\//g, "__")}.md`;
  const body = `---
title: ${JSON.stringify(page.title)}
description: ${JSON.stringify(page.description)}
path: ${JSON.stringify(page.route)}
source: ${JSON.stringify(page.sourcePath)}
---

# ${page.title}

${page.description ? `${page.description}\n\n` : ""}${page.markdown}
`;

  writeFileSync(path.join(outputDir, filename), body);
}

console.log(`Wrote ${pages.length} AI Search document(s) to ${path.relative(process.cwd(), outputDir)}.`);
