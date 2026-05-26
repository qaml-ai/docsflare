import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { content } from "../src/generated/content";

type SearchPage = {
  title: string;
  description: string;
  route: string;
  sourcePath: string;
  markdown: string;
};

const outputDir = path.join(process.cwd(), ".docsflare", "search");
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
