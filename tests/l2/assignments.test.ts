import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("L2 · vigência fundo → metodologia", () => {
  it("executa o DDL real, rejeita sobreposição e mantém lacuna como pendência", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`create schema auth;
        create table auth.users (id uuid primary key);
        create table public.funds (id uuid primary key, cnpj_fundo_master text);
        create table public.liquidity_monthly_methodologies (code text, version text, primary key (code, version));
        insert into public.funds values
          ('00000000-0000-0000-0000-000000000001', '51864349000102'),
          ('00000000-0000-0000-0000-000000000002', '00000000000002');
        insert into public.liquidity_monthly_methodologies values ('cvpar_fidc_mensal', '2026.2');`);
      const migration = readFileSync(resolve("supabase/migrations/20261003010000_liquidity_methodology_assignments.sql"), "utf8");
      const ddl = migration.slice(0, migration.indexOf("alter table public.liquidity_methodology_assignments enable row level security;"));
      expect(ddl).toContain("create trigger liquidity_methodology_assignment_no_overlap");
      await pg.exec(ddl);
      await expect(pg.exec(`update public.liquidity_monthly_methodologies
        set version = '2026.3' where code = 'cvpar_fidc_mensal'`)).rejects.toThrow("imutável");
      const seed = migration.slice(migration.indexOf("insert into public.liquidity_methodology_assignments\n"));
      await pg.exec(seed);
      const initial = await pg.query<{ cnpj_fundo_master: string; methodology_version: string }>(`
        select f.cnpj_fundo_master, a.methodology_version
        from public.funds f join public.liquidity_methodology_assignments a on a.fund_id = f.id`);
      expect(initial.rows).toEqual([{ cnpj_fundo_master: "51864349000102", methodology_version: "2026.2" }]);
      await expect(pg.exec(`insert into public.liquidity_methodology_assignments
        (fund_id, methodology_code, methodology_version, valid_from, reason)
        values ('00000000-0000-0000-0000-000000000001', 'cvpar_fidc_mensal', '2026.2', '2026-07-01', 'overlap')`))
        .rejects.toThrow("sobreposta");
      const unassigned = await pg.query<{ cnpj_fundo_master: string }>(`
        select f.cnpj_fundo_master from public.funds f
        left join public.liquidity_methodology_assignments a
          on a.fund_id = f.id and date '2026-07-01' between a.valid_from and coalesce(a.valid_to, 'infinity'::date)
        where a.id is null`);
      expect(unassigned.rows).toEqual([{ cnpj_fundo_master: "00000000000002" }]);
    } finally {
      await pg.close();
    }
  });
});
