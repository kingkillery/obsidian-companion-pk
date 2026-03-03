import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    shell: true,
  });

  const output = (result.stdout || "") + (result.stderr || "");
  const parsed = parseOutput(result.stdout || "");
  return {
    name,
    exitCode: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    parsed,
    raw: output,
  };
}

function assertStep(step, check, message) {
  if (!check) {
    throw new Error(message);
  }
}

const repoRoot = process.cwd();
const copyPluginArgs = process.argv.slice(2);
const copyCommand = copyPluginArgs.length
  ? ["run", "copy-plugin", "--", ...copyPluginArgs]
  : ["run", "copy-plugin"];
const artifactDir = path.join(repoRoot, "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

const steps = [];
let ok = true;

const commandSteps = [
  {
    name: "build",
    run: () => runCommand("build", "npm", ["run", "build"], repoRoot),
    validate: (result) => result.exitCode === 0,
  },
  {
    name: "copy-to-vault",
    run: () => runCommand("copy", "npm", copyCommand, repoRoot),
    validate: (result) => {
      if (result.exitCode !== 0) {
        return false;
      }
      const out = result.parsed || {};
      return out.all_hashes_match === true && out.vault_count > 0;
    },
  },
  {
    name: "smoke-completion",
    run: () => runCommand("smoke-completion", "npm", ["run", "smoke:completion"], repoRoot),
    validate: (result) => {
      if (result.exitCode !== 0) return false;
      const out = result.parsed || {};
      const accepted =
        out.accepted === true ||
        out.completionAcceptStatus?.status === "accepted";
      const completion = out.completionResult?.status || null;
      return !!accepted || completion === "accepted";
    },
  },
  {
    name: "smoke-slash",
    run: () => runCommand("smoke-slash", "npm", ["run", "smoke:slash"], repoRoot),
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
  },
];

for (const command of commandSteps) {
  const result = command.run();
  const passed = command.validate(result);
  steps.push({
    name: command.name,
    exitCode: result.exitCode,
    passed,
    output: result.parsed || null,
    raw_tail: result.raw,
  });
  if (!passed) {
    ok = false;
    break;
  }
}

const summary = {
  timestamp: new Date().toISOString(),
  working_directory: repoRoot,
  ok,
  steps,
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
