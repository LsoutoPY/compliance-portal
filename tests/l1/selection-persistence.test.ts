import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { FUNDS } from "./support.ts";

describe("seleção e persistência", () => {
  it("o SQL real substitui todos os fatos da competência reimportada, sem misturar tabelas antigas", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`create schema if not exists public;
        create table public.fund_monthly_cvm_filing (
          cnpj text not null, competencia date not null, tabela text not null, payload jsonb not null,
          imported_at timestamptz, registry_sync_log_id uuid, source_sha256 text,
          source_storage_path text, source_origin text,
          primary key(cnpj, competencia, tabela)
        );`);
      const migration = readFileSync(resolve("supabase/migrations/20260923010000_liquidity_monthly_validation.sql"), "utf8");
      const functionSql = migration.match(/create or replace function public\.upsert_cvm_monthly_filing\([\s\S]*?\$\$;/i)?.[0];
      expect(functionSql).toBeTruthy();
      await pg.exec(functionSql!);
      const row = (tabela: string, version: number, competencia = "2026-01-01") => ({
        cnpj: FUNDS[0], competencia, tabela, payload: [{ version }], imported_at: "2026-01-31T00:00:00Z",
        registry_sync_log_id: null, source_sha256: `synthetic-${version}`, source_storage_path: `synthetic/${version}`, source_origin: "synthetic",
      });
      const invoke = async (rows: ReturnType<typeof row>[]) => pg.query(
        "select public.upsert_cvm_monthly_filing($1::jsonb, $2::date, $3::text[]) as count",
        [JSON.stringify(rows), "2026-01-01", [FUNDS[0]]],
      );
      expect((await invoke([row("tab_I", 1), row("tab_III", 1)])).rows[0]).toEqual({ count: 2 });
      expect((await invoke([row("tab_I", 2)])).rows[0]).toEqual({ count: 1 });
      const current = await pg.query("select tabela, payload, source_sha256 from public.fund_monthly_cvm_filing order by tabela");
      expect(current.rows).toEqual([{ tabela: "tab_I", payload: [{ version: 2 }], source_sha256: "synthetic-2" }]);
      await expect(invoke([row("tab_IV", 3, "2026-02-01")])).rejects.toThrow("fora da competência");
      expect((await pg.query("select count(*)::integer as count from public.fund_monthly_cvm_filing")).rows).toEqual([{ count: 1 }]);
    } finally {
      await pg.close();
    }
  });
});
