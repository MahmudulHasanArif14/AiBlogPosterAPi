import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, describe } from "node:test";
import {
  AI_MAX_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
  MAX_PROVIDER_RETRIES,
  MAX_QUALITY_REVISIONS,
  MIN_ARTICLE_QUALITY_SCORE,
  PLATFORM_LOCALE,
  PLATFORM_TIMEZONE,
  QUALITY_CYCLE_BUDGET_MS,
} from "../src/lib/config";

// The provider knobs are validated at module load, so a bad value has to be
// observed in a fresh process. These run the config module under `tsx` with a
// hostile environment and assert on how it exits -- a NaN timeout would
// otherwise make `AbortSignal.timeout` throw on every provider call, and a NaN
// budget comparison would let the loop start calls it has no time to finish.

/** Load src/lib/config.ts in a child process with `env` applied. */
function loadConfigWith(env: Record<string, string>) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./src/lib/config.ts').then((m) => console.log(JSON.stringify({ timeout: m.AI_REQUEST_TIMEOUT_MS, tokens: m.AI_MAX_TOKENS }))).catch((e) => { console.error(e.message); process.exit(3); })",
      ],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" },
    );

    return { ok: true as const, value: JSON.parse(stdout.trim()) };
  } catch (error) {
    const err = error as { status?: number; stderr?: string };

    return { ok: false as const, status: err.status, stderr: err.stderr ?? "" };
  }
}

describe("provider configuration defaults", () => {
  test("the intended defaults are in force with no environment overrides", () => {
    assert.equal(AI_REQUEST_TIMEOUT_MS, 45_000);
    assert.equal(AI_MAX_TOKENS, 32_000);
  });

  test("the quality and rotation settings are unchanged", () => {
    // Pinned deliberately: these are the publication safeguards, and a change
    // to any of them should have to be a visible, intentional edit here.
    assert.equal(MIN_ARTICLE_QUALITY_SCORE, 85);
    assert.equal(MAX_QUALITY_REVISIONS, 5);
    assert.equal(MAX_PROVIDER_RETRIES, 3);
    assert.equal(QUALITY_CYCLE_BUDGET_MS, 15 * 60_000);
    assert.equal(PLATFORM_TIMEZONE, "Europe/London");
    assert.equal(PLATFORM_LOCALE, "en-GB");
  });
});

describe("provider configuration validation", () => {
  test("a non-numeric timeout fails at load instead of becoming NaN", () => {
    const result = loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "not-a-number" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.stderr.includes("AI_REQUEST_TIMEOUT_MS"));
  });

  test("a fractional timeout is rejected", () => {
    const result = loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "45000.5" });

    assert.equal(result.ok, false);
  });

  test("a timeout below the floor or above the ceiling is rejected", () => {
    assert.equal(loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "100" }).ok, false);
    assert.equal(loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "9000000" }).ok, false);
  });

  test("the worker's own timeout override is accepted", () => {
    // .github/workflows/daily-article.yml sets 240000 for the long-running
    // worker. If the validated range ever stopped admitting it, every
    // scheduled run would fail at import rather than at generation.
    const result = loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "240000" });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.value.timeout === 240_000);
  });

  test("an empty or absent value falls back to the default", () => {
    const result = loadConfigWith({ AI_REQUEST_TIMEOUT_MS: "" });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.value.timeout === 45_000);
  });

  test("a non-numeric token ceiling fails at load", () => {
    const result = loadConfigWith({ AI_MAX_TOKENS: "lots" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.stderr.includes("AI_MAX_TOKENS"));
  });

  test("a token ceiling outside the supported range is rejected", () => {
    // The upper bound guards against a value above what the provider accepts;
    // the lower against one too small to hold an article at all.
    assert.equal(loadConfigWith({ AI_MAX_TOKENS: "500" }).ok, false);
    assert.equal(loadConfigWith({ AI_MAX_TOKENS: "500000" }).ok, false);
  });

  test("a token ceiling inside the range is accepted", () => {
    const result = loadConfigWith({ AI_MAX_TOKENS: "64000" });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.value.tokens === 64_000);
  });
});
