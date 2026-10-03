# AGENTS.md — Portal de Risco CVPAR (Hub de 3 módulos)

Este arquivo é o contrato de trabalho para qualquer agente (Cursor, Claude Code
etc.) que for implementar código neste repositório. Leia por completo antes de
escrever qualquer arquivo.

## O que é este projeto

Portal web para o time de **Compliance + Risco** acompanhar indicadores e
**rodar os relatórios na interface**, no lugar da planilha. Três módulos ativos:

| Módulo | Rota | Status |
|---|---|---|
| **Liquidez** | `/liquidez` | Ativo — informe mensal CVM via **Atualizar dados** |
| **Mercado** | `/mercado` | Ativo — KPIs; XML da posição + informe diário CVM |
| **Enquadramento** | `/enquadramento` | Ativo — limites vs realizado; `calculate-enquadramento` |
| Crédito | _(sidenav)_ | Desabilitado — sem rota, sem página |
| Relatórios | _(sidenav)_ | Desabilitado — sem rota, sem página |

## Stack (não trocar sem confirmar com o usuário)

- Vite + React 18 + TypeScript
- React Router para navegação entre módulos
- Supabase (Postgres + Auth + RLS) como backend — projeto **novo**, isolado do
  Supabase do Frame Control Center
- **Sem Tailwind, sem shadcn/ui, sem Material UI.** O projeto usa um design
  system próprio já pronto (ver abaixo). Não instale outra biblioteca de UI.

## Regra central: fidelidade visual

Existe um mockup HTML aprovado pelo usuário em
`docs/reference/liquidez_mockup.html`. Ele é a **fonte da verdade visual** —
abra-o no navegador antes de implementar qualquer tela e replique
estrutura, espaçamento, cores e comportamento (seletor de fundo/mês, toggle
de persona Risco/Compliance, toggle de tema claro/escuro, meter do índice de
subordinação, gráfico de tendência, bucket bar, faixas empilhadas,
concentração top1/5/10/15). Não redesenhe do zero.

Regras rígidas para manter o padrão exato:

1. **Nunca declare uma cor, espaçamento, raio, sombra, fonte ou duração de
   transição com valor solto** (ex.: `color: #123456` ou `padding: 14px`).
   Use sempre uma variável CSS já definida em `src/design-system/tokens/*.css`
   (ex.: `var(--surface-brand)`, `var(--space-5)`, `var(--radius-md)`). Se um
   valor que você precisa não existir como token, pare e pergunte antes de
   inventar um novo — não amplie a paleta sem necessidade.
2. **Reutilize os componentes prontos** em `src/design-system/components/` —
   `Button`, `Card`, `Badge`, `Icon`, `IconButton` (core/), `Input`, `Select`,
   `Checkbox`, `Switch`, `SegmentedControl` (forms/), `SideNav`, `Tabs`,
   `Breadcrumbs` (navigation/). Cada componente tem um `.prompt.md` ao lado
   explicando as props e variantes — leia antes de usar. Não recrie um botão
   ou card com `<div>` solto se o componente já existe.
3. Para elementos que o kit não cobre ainda (o meter de subordinação, o
   bucket bar da previsão de liquidação, o stacked bar de faixas de
   inadimplência, o gráfico de tendência em SVG, as linhas de concentração
   com barra), copie o padrão de markup/CSS exato do bloco `<style>` e do
   HTML dentro de `docs/reference/liquidez_mockup.html` — as classes lá
   (`.kpi`, `.row2`, `.bucket-bar`, `.faixa-stack`, `.conc-row`,
   `.trend-svg` etc.) já seguem os tokens corretamente. Traduza esse HTML/CSS
   estático para componentes React, mas mantenha as mesmas classes e a mesma
   estrutura de tokens.
4. A paleta institucional é o verde-cofre (`--teal-*` / `--surface-brand`);
   os badges de severidade usam a escala fixa `--risk-baixo` → `--risk-
   moderado` → `--risk-alto` → `--risk-critico` (mesma ordem em badge,
   tabela e gráfico — não crie uma escala de cor paralela).
5. Tipografia: `Instrument Sans` para UI, `IBM Plex Mono` para números
   tabulares (`.num`, KPIs, valores em R$/%) — os `@import`/`<link>` de fonte
   já estão no `index.html` e em `tokens/fonts.css`.
6. Dark mode: os tokens já têm overrides em `[data-theme="dark"]` e em
   `@media (prefers-color-scheme: dark)`. Não hardcode cores que quebrem o
   tema escuro.

## Casca compartilhada (`AppShell`)

`src/components/AppShell.tsx` encapsula o sidenav, topbar (persona,
tema, botão Atualizar dados) e a área de scroll. **Todas as páginas de módulo
devem usar `AppShell`** — nunca renderizem `SideNav`/topbar diretamente.

- `onSelect` no `SideNav` usa `useNavigate` (React Router).
- Items do sidenav definidos em `src/lib/liquidity.ts` → `NAV_ITEMS`.
- Rotas em `src/App.tsx`: `/liquidez`, `/mercado`, `/enquadramento`.
- Crédito e Relatórios: presentes no `NAV_ITEMS` mas sem rota — clicar não navega.
- Botão **Atualizar dados** abre `ImportDialog` (XML + informes CVM + histórico).

## Arquitetura de ingestão (regra central)

A equipe **não usa planilha nem script**. Tudo entra pelo portal:

**Nenhum módulo busca dado na CVM ou XML por conta própria.**
O botão **Atualizar dados** chama `supabase.functions.invoke`. A function
grava no Postgres; a tela só consulta.

```
Portal (Atualizar dados)
        ↓
  Edge Functions (Deno)
        ↓
  Staging jsonb / tabelas de fatos
        ↓
  Liquidez | Mercado | Enquadramento
```

Edge functions disponíveis:

| Function | Dataset | Tabela alvo |
|---|---|---|
| `import-cvm-registro` | ZIP RCVM175 + cad_fi.csv | `fund_master` |
| `import-cvm-informe-mensal` | ZIP mensal FIDC | `fund_monthly_cvm_filing` |
| `import-cvm-informe-diario` | ZIP diário FI | `fund_daily_cvm` |
| `import-cvm-cda` | ZIP CDA | `fund_holdings` (fonte=`cda`) |
| `import-xml-posicao` | Upload XML custodiante | `raw_xml_files` + `fund_holdings` (fonte=`xml`) |
| `calculate-liquidity-cvm` | (lê `fund_monthly_cvm_filing`) | `liquidity_reports` |
| `calculate-market-risk` | (lê `fund_daily_cvm` + `fund_holdings`) | (resposta JSON) |
| `calculate-enquadramento` | (lê `liquidity_reports` + `compliance_limits`) | `compliance_breaches` |

Cada função grava uma linha em `ingest_runs` (status `running` → `ok`/`error`).

## Modelo de dados (Supabase)

Rode as migrations em ordem no SQL Editor do projeto:

- `0001_init.sql` — `funds`, `profiles`, `raw_imports`, `liquidity_reports`
- `0002_fund_registry.sql` — `fund_master`, `fund_isin_map`, `fund_monthly_cvm_filing`, `registry_sync_log`
- `0003_liquidity_source_reconciliation.sql` — `liquidity_reports.source` + view `liquidity_reconciliation`
- `0004_seed_cvpar_funds.sql` — 4 fundos CVPAR com CNPJs CVM
- `0005_hub_ingest_schema.sql` — `ingest_runs`, `fund_daily_cvm`, `fund_holdings`, `raw_xml_files`, `compliance_limits`, `compliance_breaches` + seed de limites
- `0006_xml_posicao.sql` — `fund_holdings.linha` / `file_name` e políticas de INSERT do XML

Resumo das tabelas:

- `funds` — 4 fundos monitorados. JOIN com cadastro: `funds.cnpj_fundo_master = fund_master.cnpj`.
- `fund_master` — cadastro CVM (fonte única de nome/CNPJ). Ver `docs/CADASTRO.md`.
- `fund_daily_cvm` — informe diário: `(cnpj, data)` PL/cota/captação/resgate/cotistas. Alimenta **Mercado**.
- `fund_holdings` — posição: `(cnpj, data, fonte, ativo)` ISIN/emissor/valor/PU. Alimenta **Mercado** e **Enquadramento**.
- `liquidity_reports` — `(fund_id, reference_month, source)` com 61 campos. Alimenta **Liquidez** e **Enquadramento**.
- `compliance_limits` — regras por fundo (min/max por código). Seed em `0005`.
- `compliance_breaches` — resultado `(fund_id, reference_month, codigo)`: realizado vs limite vs status.
- `ingest_runs` — log de cada job de ingestão (dataset, competência, status, linhas).
- `raw_xml_files` — metadata + payload JSON do XML; arquivo original no Storage `xml-posicoes`.

`src/types/database.ts` bate com o schema — não invente nomes de coluna.

## Autenticação e RBAC

Supabase Auth (magic link ou e-mail/senha) + `profiles.role`. No frontend:
esconda ações de escrita quando `role === 'compliance'`. O `AppShell` já
implementa o toggle Risco/Compliance localmente — no app real o papel vem do
Supabase Auth.

## O que não fazer

- Não adicionar Tailwind, shadcn/ui ou qualquer outra lib de componentes.
- Não inventar tokens de cor/espaçamento fora dos arquivos em `src/design-system/tokens/`.
- Não buscar dados da CVM/XML diretamente de uma página React — use a edge function correspondente.
- **Não criar scripts Python** (nem pasta `scripts/`). Ingestão é UI + Edge Function.
- Não guardar `service_role` / `sb_secret_` no frontend — só `VITE_SUPABASE_ANON_KEY`.
- Não criar páginas/rotas para Crédito ou Relatórios — ainda fora de escopo.
- Não usar comentários `#` em arquivos `.ts` de edge function (Deno — use `//`).
