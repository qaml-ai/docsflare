#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

const args = process.argv.slice(2);
const command = args[0] ?? "help";
let projectConfig = {};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  projectConfig = loadConfig(projectRoot);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(packageJson.version);
    return;
  }

  if (command === "init") {
    initProject(parseOptions(args.slice(1)));
    return;
  }

  if (command === "doctor") {
    const options = parseOptions(args.slice(1));
    const report = runDoctor(resolveContentDir(options));
    printDoctor(report);
    if (report.errors.length > 0) process.exit(1);
    return;
  }

  if (command === "build") {
    const options = parseOptions(args.slice(1));
    const contentDir = resolveContentDir(options);
    const config = resolveDeploymentConfig(contentDir);
    await build(contentDir, options, config);
    return;
  }

  if (command === "dev") {
    const options = parseOptions(args.slice(1));
    const contentDir = resolveContentDir(options);
    const config = resolveDeploymentConfig(contentDir);
    await buildContent(contentDir, options, config);
    await runTool("wrangler", wranglerArgsWithConfig(["dev"], options, config, contentDir), { contentDir, inherit: true, config });
    return;
  }

  if (command === "deploy") {
    const options = parseOptions(args.slice(1));
    const contentDir = resolveContentDir(options);
    const config = resolveDeploymentConfig(contentDir);
    await build(contentDir, options, config);
    await runTool("wrangler", wranglerArgsWithConfig(["deploy", "--env", options.env ?? "production"], options, config, contentDir), { contentDir, inherit: true, config });
    return;
  }

  if (command === "search") {
    const subcommand = args[1] ?? "sync";
    if (subcommand !== "sync") {
      throw new Error(`Unknown search command "${subcommand}". Try "docsflare search sync --url <url>".`);
    }

    const options = parseOptions(args.slice(2));
    const config = searchSyncConfig(options);
    await syncSearch(config);
    return;
  }

  throw new Error(`Unknown command "${command}". Run "docsflare help" for usage.`);
}

async function build(contentDir, options, config) {
  await buildContent(contentDir, options, config);
  await runTool("tsc", ["--noEmit"], { contentDir, config });
}

async function buildContent(contentDir, options = {}, config = resolveDeploymentConfig(contentDir)) {
  await runTool("tsx", ["scripts/build-content.ts"], { contentDir, config: configWithOptionOverrides(config, options) });
  writeWorkerRuntime(contentDir);
}

function searchSyncConfig(options) {
  const positionalUrl = isHttpUrl(options.positional[0]) ? options.positional[0] : undefined;
  const contentDir = positionalUrl ? projectRoot : resolveContentDir(options);
  const config = positionalUrl ? projectConfig : resolveDeploymentConfig(contentDir);
  const url = options.url ?? positionalUrl ?? process.env.DOCSFLARE_SEARCH_SYNC_URL ?? config.searchSyncUrl ?? config.search?.syncUrl;
  if (!url) {
    throw new Error("Missing search sync URL. Pass --url https://example.com/docs, pass the URL positionally, set DOCSFLARE_SEARCH_SYNC_URL, or set searchSyncUrl in docsflare.config.json.");
  }
  return { url: normalizeSearchSyncUrl(url) };
}

async function syncSearch(config) {
  let lastError;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: { accept: "application/json" }
      });
      const body = await response.text();

      if (body) console.log(body);
      if (response.ok) return;
      lastError = new Error(`Search sync failed with HTTP ${response.status} for ${config.url}.`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 5) await sleep(attempt * 1000);
  }

  throw lastError instanceof Error ? lastError : new Error(`Search sync failed for ${config.url}.`);
}

function parseOptions(rawArgs) {
  const options = { positional: [] };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--content" || arg === "--content-dir" || arg === "-c") {
      options.contentDir = requireValue(rawArgs, ++index, arg);
      continue;
    }

    if (arg === "--env") {
      options.env = requireValue(rawArgs, ++index, arg);
      continue;
    }

    if (arg === "--url") {
      options.url = requireValue(rawArgs, ++index, arg);
      continue;
    }

    if (arg === "--base-path") {
      options.basePath = requireValue(rawArgs, ++index, arg);
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    }

    options.positional.push(arg);
  }

  return options;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function normalizeSearchSyncUrl(value) {
  if (!isHttpUrl(value)) throw new Error(`Search sync URL must start with http:// or https://: ${value}`);
  const url = new URL(value);
  if (!url.pathname.replace(/\/$/, "").endsWith("/api/search/sync")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/search/sync`;
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireValue(rawArgs, index, option) {
  const value = rawArgs[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function resolveContentDir(options) {
  const requested = options.contentDir ?? options.positional[0];
  if (requested) return resolveProjectPath(requested);
  if (hasDocsConfig(projectRoot)) return projectRoot;

  const nestedDocsDir = path.join(projectRoot, "docs");
  return hasDocsConfig(nestedDocsDir) ? nestedDocsDir : projectRoot;
}

function loadConfig(root) {
  return mergeConfigs(readConfigFile(path.join(root, "docsflare.config.json")), readConfigFile(path.join(root, "docsflare.config.local.json")));
}

function readConfigFile(configPath) {
  if (!existsSync(configPath)) return {};

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path.basename(configPath)}: ${error instanceof Error ? error.message : error}`);
  }
}

function hasDocsConfig(dir) {
  return existsSync(path.join(dir, "docs.json")) || existsSync(path.join(dir, "mint.json"));
}

function resolveDeploymentConfig(contentDir) {
  const contentConfig = contentDir === projectRoot ? {} : loadConfig(contentDir);
  return mergeConfigs(contentConfig, projectConfig);
}

function mergeConfigs(base, override) {
  return {
    ...base,
    ...override
  };
}

function resolveProjectPath(value) {
  if (typeof value === "string" && (value === "~" || value.startsWith("~/"))) {
    const home = process.env.HOME;
    if (!home) throw new Error(`Cannot resolve ${value}: HOME is not set.`);
    return path.resolve(home, value.slice(2));
  }
  return path.resolve(projectRoot, value);
}

function configWithOptionOverrides(config, options) {
  return {
    ...config,
    basePath: options.basePath ?? config.basePath
  };
}

function runtimeBasePathForConfig(config) {
  return typeof config.basePath === "string" ? config.basePath : undefined;
}

function buildEnvForConfig(config) {
  const basePath = runtimeBasePathForConfig(config);
  return basePath === undefined ? {} : { DOCSFLARE_BASE_PATH: basePath };
}

function wranglerArgsWithConfig(args, _options, _config, contentDir = projectRoot) {
  return hasWranglerConfig(contentDir) ? args : [...args, "--config", path.join(".docsflare", "wrangler.jsonc")];
}

async function runTool(name, args, options) {
  return run(binPath(name, options.contentDir), args, {
    cwd: name === "wrangler" ? options.contentDir : packageRoot,
    inherit: options.inherit,
    env: {
      ...process.env,
      DOCSFLARE_CONTENT_DIR: options.contentDir,
      DOCSFLARE_OUTPUT_DIR: docsflareOutputDir(options.contentDir),
      ...(name === "tsx" ? buildEnvForConfig(options.config ?? {}) : {}),
      ...(options.extraEnv ?? {})
    }
  });
}

function run(commandPath, runArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, runArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.inherit ? "inherit" : ["inherit", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${path.basename(commandPath)} exited with code ${code}.`));
      }
    });
  });
}

function binPath(name, cwd = projectRoot) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const binaryName = `${name}${suffix}`;
  const candidates = [
    path.join(cwd, "node_modules", ".bin", binaryName),
    path.join(packageRoot, "node_modules", ".bin", binaryName)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? binaryName;
}

function docsflareOutputDir(contentDir) {
  return path.join(contentDir, ".docsflare");
}

function hasWranglerConfig(contentDir) {
  return ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((filename) => existsSync(path.join(contentDir, filename)));
}

function writeWorkerRuntime(contentDir) {
  const outputDir = docsflareOutputDir(contentDir);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "worker.ts"), readFileSync(path.join(packageRoot, "src", "worker.ts"), "utf8"));
  writeFileSync(path.join(outputDir, "wrangler.jsonc"), `${JSON.stringify({
    name: "docsflare",
    main: "worker.ts",
    compatibility_date: "2026-03-27",
    observability: {
      enabled: true
    },
    env: {
      production: {
        name: "docsflare"
      }
    }
  }, null, 2)}\n`);
}

function initProject(options) {
  const contentDir = resolveContentDir(options);
  const relative = path.relative(projectRoot, contentDir) || ".";

  if (existsSync(contentDir) && !statSync(contentDir).isDirectory()) {
    throw new Error(`${relative} already exists and is not a directory.`);
  }

  mkdirSync(contentDir, { recursive: true });
  writeIfAllowed(path.join(contentDir, "docs.json"), starterDocsJson(), options.force);
  writeIfAllowed(path.join(contentDir, "introduction.mdx"), starterIntroduction(), options.force);
  writeIfAllowed(path.join(contentDir, "quickstart.mdx"), starterQuickstart(), options.force);

  console.log(`Created Docsflare starter content in ${relative}.`);
  console.log(`Next: docsflare dev ${relative}`);
}

function writeIfAllowed(filePath, contents, force) {
  if (existsSync(filePath) && !force) {
    throw new Error(`${path.relative(projectRoot, filePath)} already exists. Use --force to overwrite it.`);
  }
  writeFileSync(filePath, contents);
}

function runDoctor(contentDir) {
  const errors = [];
  const warnings = [];
  const info = [];

  if (!existsSync(contentDir)) {
    return {
      contentDir,
      errors: [`Content directory does not exist: ${contentDir}`],
      warnings,
      info
    };
  }

  const stats = statSync(contentDir);
  if (!stats.isDirectory()) {
    return {
      contentDir,
      errors: [`Content path is not a directory: ${contentDir}`],
      warnings,
      info
    };
  }

  const configFile = ["docs.json", "mint.json"].find((filename) => existsSync(path.join(contentDir, filename)));
  if (!configFile) {
    errors.push("Missing docs.json or mint.json.");
  } else {
    info.push(`Found ${configFile}.`);
    try {
      const siteConfig = JSON.parse(readFileSync(path.join(contentDir, configFile), "utf8"));
      const missing = missingNavigationPages(contentDir, siteConfig.navigation);
      errors.push(...missing.map((page) => `Navigation references missing page: ${page}`));
    } catch (error) {
      errors.push(`Could not parse ${configFile}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const mdxFiles = listFiles(contentDir).filter((file) => /\.(md|mdx)$/i.test(file));
  if (mdxFiles.length === 0) {
    errors.push("No Markdown or MDX files found.");
  } else {
    info.push(`Found ${mdxFiles.length} Markdown/MDX file(s).`);
  }

  for (const file of mdxFiles) {
    const source = readFileSync(path.join(contentDir, file), "utf8");
    if (/^\s*import\s/m.test(source)) {
      warnings.push(`${file} contains import statements; custom React imports are not bundled yet.`);
    }
    if (/^\s*export\s/m.test(source)) {
      warnings.push(`${file} contains export statements; page-level exports may not render as expected.`);
    }
  }

  return { contentDir, errors, warnings, info };
}

function missingNavigationPages(root, navigation) {
  const refs = collectNavigationRefs(navigation);
  return refs.filter((ref) => !resolvePage(root, ref));
}

function collectNavigationRefs(value) {
  const refs = [];

  function visit(item) {
    if (typeof item === "string") {
      if (!isExternal(item)) refs.push(stripExtension(item));
      return;
    }

    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    if (!item || typeof item !== "object") return;

    const page = firstString(item.page, item.path, item.href, item.url);
    if (page && !isExternal(page)) refs.push(stripExtension(page));

    for (const key of ["pages", "groups", "tabs", "anchors", "dropdowns", "versions"]) {
      if (item[key]) visit(item[key]);
    }
  }

  visit(value);
  return [...new Set(refs)];
}

function resolvePage(root, pagePath) {
  const normalized = pagePath.replace(/^\/+/, "");
  return [
    normalized,
    `${normalized}.mdx`,
    `${normalized}.md`,
    path.join(normalized, "index.mdx"),
    path.join(normalized, "index.md")
  ].some((candidate) => {
    const absolute = path.join(root, candidate);
    return existsSync(absolute) && statSync(absolute).isFile();
  });
}

function listFiles(dir, base = dir) {
  const ignored = new Set([".git", ".wrangler", ".docsflare", "dist", "node_modules"]);
  const entries = [];

  for (const entry of readdirSafe(dir)) {
    if (ignored.has(entry)) continue;
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);

    if (stats.isDirectory()) {
      entries.push(...listFiles(absolute, base));
    } else if (stats.isFile()) {
      entries.push(path.relative(base, absolute).replace(/\\/g, "/"));
    }
  }

  return entries;
}

function readdirSafe(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function stripExtension(value) {
  return value.replace(/\.(mdx|md)$/i, "").replace(/\/index$/i, "");
}

function isExternal(value) {
  return /^https?:\/\//.test(value) || value.startsWith("mailto:") || value.startsWith("#");
}

function printDoctor(report) {
  console.log(`Docsflare doctor: ${path.relative(projectRoot, report.contentDir) || "."}`);

  for (const item of report.info) console.log(`[ok] ${item}`);
  for (const item of report.warnings) console.log(`[warn] ${item}`);
  for (const item of report.errors) console.log(`[error] ${item}`);

  if (report.errors.length === 0) {
    console.log("No blocking issues found.");
  }
}

function printHelp() {
  console.log(`Docsflare ${packageJson.version}

Usage:
  docsflare init [content-dir] [--force]
  docsflare dev [content-dir]
  docsflare build [content-dir]
  docsflare deploy [content-dir] [--env production]
  docsflare search sync --url https://example.com/docs
  docsflare doctor [content-dir]

Options:
  -c, --content-dir <dir>  Content directory. Defaults to the current docs root.
  --env <name>            Wrangler environment for deploy. Defaults to production.
  --url <url>             Deployed docs URL or full /api/search/sync URL.
  --base-path <path>      Optional mounted path, such as /docs.
  --force                 Allow init to overwrite starter files.

docsflare.config.json:
  {
    "basePath": "/docs",
    "searchSyncUrl": "https://example.com/docs"
  }`);
}

function starterDocsJson() {
  return `${JSON.stringify({
    name: "My Docs",
    navigation: [
      {
        group: "Getting Started",
        pages: ["introduction", "quickstart"]
      }
    ]
  }, null, 2)}
`;
}

function starterIntroduction() {
  return `---
title: Introduction
description: Start here.
---

# Introduction

Welcome to your Docsflare site.
`;
}

function starterQuickstart() {
  return `---
title: Quickstart
description: Run your docs locally.
---

# Quickstart

\`\`\`bash
docsflare dev docs
\`\`\`
`;
}
