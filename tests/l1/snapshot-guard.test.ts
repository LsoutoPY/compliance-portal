import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FIXTURES, FUNDS } from "./support.ts";

describe("controle de atualização de snapshots", () => {
  it("o gerador recusa execução sem flag e preserva o JSON esperado", () => {
    const file = resolve(FIXTURES, `synthetic_expected_202601_${FUNDS[0]}.json`);
    const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = sha();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "tests/l1/generate-fixtures.mjs"], {
      cwd: process.cwd(), env: { ...process.env, L1_UPDATE_SNAPSHOTS: "0" }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("L1_UPDATE_SNAPSHOTS=1");
    expect(sha()).toBe(before);
  });
});
