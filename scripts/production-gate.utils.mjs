import path from "node:path";

export function splitVaultList(value) {
  if (!value || typeof value !== "string") {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseVaultPaths(args = []) {
  const fromArgs = [];

  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] === "--vault" && args[idx + 1]) {
      fromArgs.push(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (args[idx] === "--vaults" && args[idx + 1]) {
      fromArgs.push(...splitVaultList(args[idx + 1]));
      idx += 1;
      continue;
    }
  }

  if (fromArgs.length > 0) {
    const set = new Set();
    const normalized = [];

    for (const vaultPath of fromArgs) {
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
    .flatMap(splitVaultList)
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

export function parseReleaseGateArgs(args = []) {
  const copyArgs = [];
  const options = {
    skipSmoke: false,
    skipCopy: false,
  };

  for (let idx = 0; idx < args.length; idx++) {
    const token = args[idx];

    if (token === "--skip-smoke" || token === "--no-smoke") {
      options.skipSmoke = true;
      continue;
    }
    if (token === "--skip-copy") {
      options.skipCopy = true;
      continue;
    }

    if (token === "--vault") {
      if (args[idx + 1]) {
        copyArgs.push(token, args[idx + 1]);
        idx += 1;
      }
      continue;
    }

    if (token === "--vaults") {
      if (args[idx + 1]) {
        copyArgs.push(token, args[idx + 1]);
        idx += 1;
      }
      continue;
    }

    copyArgs.push(token);
  }

  if (process.env.RELEASE_CHECK_SKIP_SMOKE === "1") {
    options.skipSmoke = true;
  }
  if (process.env.RELEASE_CHECK_SKIP_COPY === "1") {
    options.skipCopy = true;
  }

  return {
    copyArgs,
    options,
  };
}
