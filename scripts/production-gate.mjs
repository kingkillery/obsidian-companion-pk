import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseReleaseGateArgs(args) {
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

  return { copyArgs, options };
}

function splitVaultList(value) {
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
      from_args.push(...splitVaultList(args[idx + 1]));
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

function now_iso() {
  return new Date().toISOString();
}

function parseOpenrouterApiKeyFromVault(vaultPath) {
  const dataPath = path.join(
    vaultPath,
    ".obsidian",
    "plugins",
    "obsidian-companion",
    "data.json"
  );
  if (!fs.existsSync(dataPath)) {
    return { found: false };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    const provider = payload?.provider === "openrouter" ? "openrouter" : null;
    const fallbackProvider = provider || "openrouter";
    const providerRecord = payload?.provider_settings?.[fallbackProvider];
    if (!providerRecord?.settings || typeof providerRecord.settings !== "string") {
      return { found: false, source: "data.json", vaultPath };
    }
    const providerSettings = JSON.parse(providerRecord.settings);
    const key = typeof providerSettings.api_key === "string" ? providerSettings.api_key.trim() : "";
    return {
      found: key.length > 0,
      source: "data.json",
      vaultPath,
      provider: fallbackProvider,
      keyPreview: key ? `${key.slice(0, 6)}...` : "",
    };
  } catch {
    return { found: false, source: "data.json", vaultPath, parseError: true };
  }
}

function preflight(copyPluginArgs) {
  const started = Date.now();
  const errors = [];
  const warnings = [];
  const vault_paths = parse_vault_paths(copyPluginArgs);

  if (!fs.existsSync("node_modules")) {
    errors.push("node_modules is missing. Run npm install.");
  }
  if (!fs.existsSync("package.json")) {
    errors.push("package.json is missing.");
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(nodeMajor) || nodeMajor < 16) {
    warnings.push(`Node.js ${process.versions.node} detected; Node 16+ recommended.`);
  }

  if (!vault_paths.length) {
    errors.push(
      "No vault path(s) configured. Pass --vault <path>, --vaults <comma-separated>, or set OBSIDIAN_VAULT_PATH(S)."
    );
  }

  let hasOpenRouterKey = false;
  const explicitOpenrouterKey = typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.trim().length > 0;
  if (explicitOpenrouterKey) {
    hasOpenRouterKey = true;
  }

  for (const vaultPath of vault_paths) {
    const result = {
      path: vaultPath,
      exists: false,
      is_directory: false,
      writable: false,
      plugin_data: false,
      provider_key: null,
    };

    try {
      const stat = fs.statSync(vaultPath);
      result.exists = true;
      result.is_directory = stat.isDirectory();
    } catch {
      errors.push(`Vault not found or inaccessible: ${vaultPath}`);
      continue;
    }

    if (!result.is_directory) {
      errors.push(`Vault path is not a directory: ${vaultPath}`);
      continue;
    }

    try {
      fs.accessSync(vaultPath, fs.constants.W_OK);
      result.writable = true;
    } catch {
      errors.push(`Vault is not writable: ${vaultPath}`);
    }

    const pluginDataPath = path.join(
      vaultPath,
      ".obsidian",
      "plugins",
      "obsidian-companion",
      "data.json"
    );
    result.plugin_data = fs.existsSync(pluginDataPath);

    const keyResult = parseOpenrouterApiKeyFromVault(vaultPath);
    result.provider_key = keyResult;
    if (keyResult.found) {
      result.provider_key = keyResult;
      hasOpenRouterKey = true;
    }
  }

  if (!hasOpenRouterKey) {
    warnings.push(
      "OpenRouter API key not detected in env (OPENROUTER_API_KEY) or any vault plugin settings (data.json). Completion smoke may fail."
    );
  }

  return {
    started_at: now_iso(),
    duration_ms: Date.now() - started,
    vault_paths,
    errors,
    warnings,
    passed: errors.length === 0,
    copy_env: {
      OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH || null,
      OBSIDIAN_VAULT_PATHS: process.env.OBSIDIAN_VAULT_PATHS || null,
    },
  };
}

function parseOutput(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}\s*$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function runCommand(name, command, args = [], cwd = process.cwd(), env = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    shell: true,
  });
  const ended = Date.now();

  const output = (result.stdout || "") + (result.stderr || "");
  const parsed = parseOutput(result.stdout || "");
  return {
    name,
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    duration_ms: ended - started,
    parsed,
    error: result.error
      ? {
          message: String(result.error.message || "unknown"),
          code: result.error.code || null,
          errno: result.error.errno || null,
        }
      : null,
    raw: output,
  };
}

const repoRoot = process.cwd();
const { copyArgs: copyPluginArgs, options: gateOptions } = parseReleaseGateArgs(
  process.argv.slice(2)
);
const copyCommand = copyPluginArgs.length
  ? ["run", "copy-plugin", "--", ...copyPluginArgs]
  : ["run", "copy-plugin"];
const artifactDir = path.join(repoRoot, "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const runStartedAt = Date.now();

const steps = [];
let ok = true;
const preflightStep = preflight(copyPluginArgs);
steps.push({
  name: "preflight",
  passed: preflightStep.passed,
  duration_ms: preflightStep.duration_ms,
  command: "release-gate preflight",
  started_at: preflightStep.started_at,
  ended_at: now_iso(),
  output: {
    errors: preflightStep.errors,
    warnings: preflightStep.warnings,
    vault_paths: preflightStep.vault_paths,
    copy_env: preflightStep.copy_env,
  },
});

if (!preflightStep.passed) {
  ok = false;
} else {
  const commandSteps = [
    {
      name: "build",
      command: "npm",
      args: ["run", "build"],
      run: () => runCommand("build", "npm", ["run", "build"], repoRoot),
      validate: (result) => result.exitCode === 0,
    },
  ];

  if (!gateOptions.skipCopy) {
    commandSteps.push({
      name: "copy-to-vault",
      command: "npm",
      args: ["run", "copy-plugin", ...copyCommand.slice(1)],
      run: () => runCommand("copy", "npm", copyCommand, repoRoot),
      validate: (result) => {
        if (result.exitCode !== 0) {
          return false;
        }
        const out = result.parsed || {};
        const vaultResults = Array.isArray(out.vaults) ? out.vaults : [];
        return (
          out.all_hashes_match === true &&
          out.vault_count > 0 &&
          vaultResults.every((entry) => entry?.all_hashes_match === true)
        );
      },
    });
  }

  if (!gateOptions.skipSmoke) {
    commandSteps.push({
      name: "smoke-completion",
      command: "npm",
      args: ["run", "smoke:completion"],
      run: () =>
        runCommand(
          "smoke-completion",
          "npm",
          ["run", "smoke:completion"],
          repoRoot
        ),
      validate: (result) => {
        if (result.exitCode !== 0) return false;
        const out = result.parsed || {};
        const accepted =
          out.accepted === true ||
          out.completionAcceptStatus?.status === "accepted";
        const completion = out.completionResult?.status || null;
        return !!accepted || completion === "accepted";
      },
    });
    commandSteps.push({
      name: "smoke-slash",
      command: "npm",
      args: ["run", "smoke:slash"],
      run: () =>
        runCommand("smoke-slash", "npm", ["run", "smoke:slash"], repoRoot),
      validate: (result) => {
        if (result.exitCode !== 0) return false;
        const out = result.parsed || {};
        return (
          !!out.atOpenExecWorked &&
          !!out.atLinkExecWorked &&
          (!out.atOpenExecResult || out.atOpenExecResult.success !== false) &&
          (!out.atLinkExecResult || out.atLinkExecResult.success !== false)
        );
      },
    });
  }

  for (const command of commandSteps) {
    const startedAt = now_iso();
    const startedTs = Date.now();
    const result = command.run();
    const endedTs = Date.now();
    const endedAt = new Date(endedTs).toISOString();
    const passed = command.validate(result);
    steps.push({
      name: command.name,
      exitCode: result.exitCode,
      duration_ms: result.duration_ms || Math.max(0, endedTs - startedTs),
      command: command.command,
      args: command.args,
      started_at: startedAt,
      ended_at: endedAt,
      passed,
      output: result.parsed || null,
      raw_tail: result.raw,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || null,
    });
    if (!passed) {
      ok = false;
      break;
    }
  }
  if (commandSteps.length === 0) {
    steps.push({
      name: "skip-phase",
      passed: true,
      duration_ms: 0,
      command: "release-gate",
      args: ["--skip-smoke", "--skip-copy"],
      started_at: now_iso(),
      ended_at: now_iso(),
      output: {
        skipped: "All runtime phases were skipped; no copy or smoke targets configured to run",
      },
    });
  }
}

const summary = {
  timestamp: now_iso(),
  command: ["node", "scripts/production-gate.mjs", ...copyPluginArgs].join(" "),
  working_directory: repoRoot,
  duration_ms: Date.now() - runStartedAt,
  ok,
  steps,
  preflight: preflightStep,
};

const artifactPath = path.join(
  artifactDir,
  `production-gate-${timestamp}.json`
);
fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (!ok) {
  process.exit(1);
}
