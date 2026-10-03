# Risco CVPAR — Hub de Risco (3 módulos)

Portal web para a equipe de **risco e compliance** acompanhar e atualizar os
relatórios dos fundos CVPAR. A operação é só na interface — XML da posição e
informes da CVM entram pelo botão **Atualizar dados**. Leia **AGENTS.md**
antes de qualquer alteração.

## Liquidez mensal FIDC — documentação vigente

O fluxo mensal em `/liquidez/mensal` usa a metodologia versionada
`cvpar_fidc_mensal@2026.2`. Consulte:

- [Metodologia, fórmulas, fontes, lacunas e preparação para mais de 50 fundos](docs/METODOLOGIA_LIQUIDEZ_FIDC.md);
- [Validação contra os informes de junho/julho e confronto com o Excel](docs/VALIDACAO_LIQUIDEZ_CVPAR_2026.md);
- [Mapeamento de linhas da planilha](docs/MAPEAMENTO_PLANILHA_LIQUIDEZ.md);
- [Implantação e permissões no fork CVPAR](docs/DEPLOY_LIQUIDEZ_ISOLADO.md).

Para importar: **Dados → Importar → Informes CVM**, selecionar competência e
**Importar da CVM** ou **Enviar ZIP**. O portal arquiva a origem e calcula
automaticamente os fundos encontrados no ZIP. A Base do portal fica em
**Liquidez → FIDC mensal**; em **Dados e parâmetros** é possível recalcular
após incluir uma Carteira Diária ou corrigir uma falha individual. O Excel é
referência de teste e não alimenta o cálculo.

## Módulos

| Módulo | Rota | Dados |
|---|---|---|
| **Liquidez** | `/liquidez` | `liquidity_reports` ← informe mensal CVM |
| **Mercado** | `/mercado` | `fund_daily_cvm` + `fund_holdings` (XML / CDA) |
| **Enquadramento** | `/enquadramento` | `compliance_breaches` ← `calculate-enquadramento` |

Crédito e Relatórios aparecem no sidenav mas não têm rota nesta fase.

## Setup rápido

```bash
cd compliance-portal
npm install
cp .env.example .env.local   # preencher VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:5173
```

### Banco de dados

Cole as migrations em ordem no SQL Editor do projeto Supabase:

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_fund_registry.sql
supabase/migrations/0003_liquidity_source_reconciliation.sql
supabase/migrations/0004_seed_cvpar_funds.sql
supabase/migrations/0005_hub_ingest_schema.sql
supabase/migrations/0006_xml_posicao.sql
```

### Como a equipe atualiza os dados

No portal, botão **Atualizar dados**:

1. **XML da posição** — envia o arquivo da custodiante; a alocação aparece em Mercado.
2. **Informes CVM** — informe a competência (`AAAA-MM`) e clique em **Atualizar competência**.
   O portal baixa os informes públicos, grava liquidez/mercado e recalcula o enquadramento.

Toda ingestão roda em Edge Functions (Deno) no Supabase. A tela só consulta o Postgres.
Não há script local para a equipe executar.

Publique as functions no projeto (`supabase functions deploy` ou dashboard):

| Function | Quando | Body |
|---|---|---|
| `import-cvm-registro` | cadastro | `{}` |
| `import-cvm-informe-mensal` | mensal | `{"competencia": "2026-07"}` |
| `import-cvm-informe-diario` | diário | `{"competencia": "2026-07"}` |
| `import-cvm-cda` | mensal | `{"competencia": "2026-07"}` |
| `import-xml-posicao` | upload XML | `{"xml": "...", "file_name": "posicao.xml"}` |
| `calculate-liquidity-cvm` | após informe mensal | `{"competencia": "2026-07"}` |
| `calculate-market-risk` | após informe diário | `{"competencia": "2026-07"}` |
| `calculate-enquadramento` | após liquidez | `{"competencia": "2026-07"}` |

Opcional: Cron no dashboard para jobs diários/mensais automáticos.

## Estrutura

```
src/
  components/AppShell.tsx     casca compartilhada (sidenav + topbar + Atualizar dados)
  components/ImportDialog.tsx XML + informes CVM + histórico
  design-system/              tokens + componentes (Button, Card, SideNav, …)
  lib/
    supabaseClient.ts
    liquidity.ts
    format.ts
  types/database.ts
  pages/
    LiquidezPage.tsx
    MercadoPage.tsx
    EnquadramentoPage.tsx
  App.tsx                     rotas: /liquidez /mercado /enquadramento

supabase/
  migrations/
  functions/
    _shared/cors.ts
    import-cvm-registro/
    import-cvm-informe-mensal/
    import-cvm-informe-diario/
    import-cvm-cda/
    import-xml-posicao/
    calculate-liquidity-cvm/
    calculate-market-risk/
    calculate-enquadramento/

docs/
  CADASTRO.md
  reference/liquidez_mockup.html
```

## Referência visual

`docs/reference/liquidez_mockup.html` — abra direto no navegador.
Risco de Mercado e Enquadramento seguem o mesmo sistema de tokens/componentes.
