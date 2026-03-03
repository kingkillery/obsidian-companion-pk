import assert from "node:assert/strict";
import path from "node:path";
import {
  parseReleaseGateArgs,
  parseVaultPaths,
} from "./production-gate.utils.mjs";

function withEnv(env, fn) {
  const previous = {};
  const keys = Object.keys(env);

  for (const key of keys) {
    if (Object.hasOwn(process.env, key)) {
      previous[key] = process.env[key];
    } else {
      previous[key] = undefined;
    }
    process.env[key] = env[key];
  }

  try {
    fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function main() {
  const cwdVaultA = path.resolve("vault-a");
  const cwdVaultB = path.resolve("vault-b");
  const cwdVaultC = path.resolve("vault-c");

  {
    const parsed = parseReleaseGateArgs([
      "--vault",
      "vault-a",
      "--vaults",
      "vault-b,vault-c;vault-a",
      "--skip-smoke",
      "--skip-copy",
      "--other-arg",
    ]);
    assert.deepEqual(parsed.options, { skipSmoke: true, skipCopy: true });
    assert.deepEqual(parsed.copyArgs, [
      "--vault",
      "vault-a",
      "--vaults",
      "vault-b,vault-c;vault-a",
      "--other-arg",
    ]);

    const vaults = parseVaultPaths(parsed.copyArgs);
    assert.deepEqual(vaults, [cwdVaultA, cwdVaultB, cwdVaultC]);
  }

  withEnv(
    {
      OBSIDIAN_VAULT_PATH: "vault-a",
      OBSIDIAN_VAULT_PATHS: "vault-b;vault-c,vault-b",
    },
    () => {
      const vaults = parseVaultPaths([]);
      assert.deepEqual(vaults, [cwdVaultA, cwdVaultB, cwdVaultC]);
    }
  );

  {
    withEnv(
      {
        RELEASE_CHECK_SKIP_SMOKE: "1",
        RELEASE_CHECK_SKIP_COPY: "0",
      },
      () => {
        const parsed = parseReleaseGateArgs(["--vault", "vault-a", "--skip-copy"]);
        assert.equal(parsed.options.skipSmoke, true);
        assert.equal(parsed.options.skipCopy, true);
      }
    );
  }

  {
    withEnv(
      {
        RELEASE_CHECK_SKIP_SMOKE: "0",
        RELEASE_CHECK_SKIP_COPY: "1",
      },
      () => {
        const parsed = parseReleaseGateArgs(["--vault", "vault-a"]);
        assert.equal(parsed.options.skipSmoke, false);
        assert.equal(parsed.options.skipCopy, true);
      }
    );
  }

  {
    withEnv(
      {
        OBSIDIAN_VAULT_PATH: "",
        OBSIDIAN_VAULT_PATHS: "",
      },
      () => {
        const vaults = parseVaultPaths(["--vault", "vault-a", "--vaults", "vault-b"]);
        assert.deepEqual(vaults, [cwdVaultA, cwdVaultB]);
      }
    );
  }

  {
    const parsed = parseVaultPaths(["--vault", "vault-a", "--vault", "vault-a", "--vaults", "vault-b"]);
    assert.deepEqual(parsed, [cwdVaultA, cwdVaultB]);
  }

  console.log("production-gate parser tests passed");
}

main();
