# Cadastro mestre de fundos

Camada compartilhada por todos os módulos do portal (liquidez, e depois
crédito/enquadramento). Resolve "eu só tenho um CNPJ, preciso do
nome/administrador/gestor/PL oficial" sem cada módulo reinventar essa lógica.

JOIN único: `funds.cnpj_fundo_master = fund_master.cnpj` (CNPJ só com dígitos).

## Tabelas (`supabase/migrations/0002_fund_registry.sql`)

- **`fund_master`** — um registro por fundo, classe ou subclasse CVM.
  Chave: `(fonte, tipo_registro, id_cvm)`. Guarda a linha crua em `raw_payload`.
- **`fund_isin_map`** — ISIN → CNPJ. **Ainda não tem fonte** (B3/ANBIMA ou o
  XML de posição do FCC).
- **`fund_monthly_cvm_filing`** — Informe Mensal FIDC, uma linha por
  `(cnpj, competência, tabela)` com `payload` = array jsonb das linhas da
  tabela (tab_VIII e tab_X_* têm N linhas).
- **`registry_sync_log`** — auditoria de cada sync.
- **`funds.cnpj_fundo_master`** — liga o fundo monitorado (CVPAR EDUC etc.)
  ao CNPJ oficial.

## Fundos monitorados (seed `0004`)

| short_name | CNPJ (dígitos) | denominação CVM |
|---|---|---|
| CVPAR EDUC | 51864349000102 | CVPAR EDUC FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS |
| CVPAR I | 23104485000169 | CVPAR I FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS RESPONSABILIDADE LIMITADA |
| CVPAR II | 47425841000104 | CVPAR II FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS - RESPONSABILIDADE LIMITADA |
| CVPAR NC | 58426775000103 | CVPAR NC FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS RESPONSABILIDADE LIMITADA |

## Fontes (Portal de Dados Abertos da CVM)

| Dataset | URL |
|---|---|
| Cadastro RCVM175 | `dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip` |
| Cadastro legado CADFI | `dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv` |
| Informe Mensal FIDC | `dados.cvm.gov.br/dados/FIDC/DOC/INF_MENSAL/DADOS/inf_mensal_fidc_AAAAMM.zip` |
| Dicionário do informe | `dados.cvm.gov.br/dados/FIDC/DOC/INF_MENSAL/META/meta_inf_mensal_fidc_txt.zip` |

No portal: **Atualizar dados → Informes CVM → Cadastro de fundos** (`import-cvm-registro`) e **Informe mensal** (`import-cvm-informe-mensal`).

## Informe Mensal como fonte de liquidez (validado Jul/2026)

| Campo | Fórmula | Fonte | Validação |
|---|---|---|---|
| `indice_subordinacao` | (Σ qtd×vl_cota das classes ≠ Senior) / (Σ todas) | `tab_X_2` | exato nos 4 fundos |
| `mov_entradas`/`mov_saidas` | soma `TAB_X_VL_TOTAL` por `TAB_X_TP_OPER` | `tab_X_4` | exato em EDUC/II/NC; saídas da referência interna são negativas (CVM grava o mesmo sinal) |
| `baixa_recompra` | `TAB_VII_D_2_VL_RECOMPRA` | `tab_VII` | ~0,3% de diferença |
| `conc_sacados_topN` | topN(tab_VIII.VALOR) / tab_I.TAB_I_VL_ATIVO | `tab_VIII` + `tab_I` | só CVM |
| `volume_dc_vencidos` | I2A2+I2A3+I2B2+I2B3 | `tab_I` | alinhado ao histórico interno |
| `valor_vencidos_total` | mesma fórmula | `tab_I` | definição CVM mais estreita que a linha homônima do histórico |
| `pl` | `TAB_IV_A_VL_PL` | `tab_IV` | exato nos 4 fundos |
| `saldo_tesouraria` | `TAB_I1_VL_DISP` (R$) | `tab_I` | CVM em R$; o modo Comparar normaliza em % do PL |

`CVPAR I` foi o que mais divergiu (captação, volume DC, títulos públicos) — o histórico interno parece olhar só a classe subordinada; o informe CVM soma Senior + Mezanino + Subordinada.

A tela Liquidez abre no **Informe CVM**. O modo **Comparar** confronta a referência interna com o informe no próprio portal.

A view `liquidity_reconciliation` (migração `0003`) compara as duas fontes **no banco**. Sem a coluna `source`, o histórico não pode coexistir com o informe. Linhas `source = 'cvm_informe_mensal'` nunca sobrescrevem `manual_xlsx`.

## Em aberto: ISIN → fundo

A CVM não expõe ISIN nesses cadastros. Vem da B3/ANBIMA ou do XML de posição.
Sem isso o portal resolve **CNPJ → nome** de ponta a ponta, mas não **ISIN → nome**.
