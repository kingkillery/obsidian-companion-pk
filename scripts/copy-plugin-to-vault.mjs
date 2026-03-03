import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

function resolve_repo_root() {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  return path.resolve(scriptDir, "..");
}

function split_vault_list(value) {
  if (!value || typeof value !== "string") {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parse_vault_paths(args) {
  const from_args = [];
  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] === "--vault" && args[idx + 1]) {
      from_args.push(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (args[idx] === "--vaults" && args[idx + 1]) {
      from_args.push(...split_vault_list(args[idx + 1]));
      idx += 1;
    }
  }

  if (from_args.length > 0) {
    const set = new Set();
    const normalized = [];
    for (const vaultPath of from_args) {
      if (!vaultPath) continue;
      const normalizedPath = path.resolve(vaultPath);
      if (!set.has(normalizedPath)) {
        set.add(normalizedPath);
        normalized.push(normalizedPath);
      }
    }
    return normalized;
  }

  const envList = [
    process.env.OBSIDIAN_VAULT_PATH,
    process.env.OBSIDIAN_VAULT_PATHS,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .flatMap(split_vault_list)
    .map((vaultPath) => path.resolve(vaultPath));

  const set = new Set();
  const normalized = [];
  for (const vaultPath of envList) {
    if (!set.has(vaultPath)) {
      set.add(vaultPath);
      normalized.push(vaultPath);
    }
  }
  return normalized;
}

function hash_file(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function copy_to_vault(vaultPath, repoRoot, files) {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "obsidian-companion");
  fs.mkdirSync(pluginDir, { recursive: true });
  const copied = {};
  for (const fileName of files) {
    const source = path.join(repoRoot, fileName);
    const target = path.join(pluginDir, fileName);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing source plugin artifact: ${source}`);
    }
    const source_hash = hash_file(source);
    fs.copyFileSync(source, target);
    const target_hash = hash_file(target);
    copied[fileName] = {
      source,
      target,
      source_hash,
      target_hash,
      hashes_match: source_hash === target_hash,
    };
  }
  return {
    vaultPath,
    pluginDir,
    files: copied,
    all_hashes_match: Object.values(copied).every((entry) => entry.hashes_match),
  };
}

const args = process.argv.slice(2);
const vaultPaths = parse_vault_paths(args);
if (!vaultPaths.length) {
  console.error(
    "Missing vault path(s). Pass --vault <path>, --vaults <path1,path2>, or set OBSIDIAN_VAULT_PATH(S)."
  );
  process.exit(1);
}

const repoRoot = resolve_repo_root();
const files = ["main.js", "manifest.json", "styles.css"];
const artifactDir = path.join(repoRoot, "artifacts");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

fs.mkdirSync(artifactDir, { recursive: true });

const vault_results = vaultPaths.map((vaultPath) => copy_to_vault(vaultPath, repoRoot, files));
const all_ok = vault_results.every((entry) => entry.all_hashes_match);

const output = {
  timestamp: new Date().toISOString(),
  vault_count: vaultPaths.length,
  vaults: vault_results,
  all_hashes_match: all_ok,
};

const outputPath = path.join(artifactDir, `copy-plugin-to-vault-${timestamp}.json`);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
if (!all_ok) {
  process.exit(1);
}
