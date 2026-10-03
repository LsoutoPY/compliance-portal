# L1 — Matriz de cobertura das 74 linhas

`G4` = quatro snapshots exatos de `motor.test.ts`; `I` = fórmula independente em `independent-formulas.test.ts` (quatro casos); `R` = renderização e contagem de `report-ui.test.tsx`; `P` = 74 linhas por fundo e nomes no `pdf.test.ts`; `E` = teste adicional de borda indicado. `coverage.test.ts` confere todas as identidades e os campos dos JSONs. As sete lacunas têm `n/d` com ressalva, sem cálculo inventado.

| # | Seção | Indicador | Tipo | G4 | I | R | P | E |
|---:|---|---|---|:---:|:---:|:---:|:---:|---|
| 1 | Despesas e CPR | Taxa de administração | métrica | ✓ | — | ✓ | ✓ | CPR ausente (motor.test.ts), parser (parsers.test.ts) |
| 2 | Despesas e CPR | Taxa de custódia | métrica | ✓ | — | ✓ | ✓ | CPR ausente (motor.test.ts), parser (parsers.test.ts) |
| 3 | Despesas e CPR | Taxa de gestão | métrica | ✓ | — | ✓ | ✓ | CPR ausente (motor.test.ts), parser (parsers.test.ts) |
| 4 | Despesas e CPR | Outras despesas | métrica | ✓ | — | ✓ | ✓ | CPR ausente (motor.test.ts), parser (parsers.test.ts) |
| 5 | Despesas e CPR | CPR residual do informe | métrica | ✓ | — | ✓ | ✓ | — |
| 6 | Movimentação | Entradas / captações | métrica | ✓ | — | ✓ | ✓ | — |
| 7 | Movimentação | Saídas / resgates e amortizações | métrica | ✓ | ✓ | ✓ | ✓ | borda da linha (report-row-edges.test.ts) |
| 8 | Movimentação | Movimentação líquida | métrica | ✓ | — | ✓ | ✓ | — |
| 9 | Alocação de ativos | Patrimônio líquido | métrica | ✓ | ✓ | ✓ | ✓ | — |
| 10 | Alocação de ativos | DC total bruto | métrica | ✓ | ✓ | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 11 | Alocação de ativos | DC direto bruto | métrica | ✓ | — | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 12 | Alocação de ativos | Cotas FIDC | métrica | ✓ | — | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 13 | Alocação de ativos | Outros VM de crédito | métrica | ✓ | — | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 14 | Alocação de ativos | DC a vencer · estimativa | métrica | ✓ | — | ✓ | ✓ | — |
| 15 | Alocação de ativos | DC vencidos | métrica | ✓ | ✓ | ✓ | ✓ | — |
| 16 | Alocação de ativos | PDD | métrica | ✓ | ✓ | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 17 | Alocação de ativos | Títulos públicos / compromissadas | métrica | ✓ | — | ✓ | ✓ | — |
| 18 | Alocação de ativos | Cotas de FIF / liquidez | métrica | ✓ | — | ✓ | ✓ | — |
| 19 | Alocação de ativos | Tesouraria | métrica | ✓ | — | ✓ | ✓ | — |
| 20 | Indicadores de alocação | DC bruto / PL | métrica | ✓ | — | ✓ | ✓ | denominador (motor.test.ts) |
| 21 | Indicadores de alocação | PDD / PL | métrica | ✓ | — | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 22 | Indicadores de alocação | DC líquido de PDD / PL · fórmula corrigida | métrica | ✓ | — | ✓ | ✓ | PDD/DC/opcional (motor.test.ts) |
| 23 | Indicadores de alocação | Liquidez imediata contábil | métrica | ✓ | — | ✓ | ✓ | — |
| 24 | Indicadores de alocação | Liquidez imediata + DC ≤ 30 d / PL | métrica | ✓ | — | ✓ | ✓ | denominador (motor.test.ts) |
| 25 | Prazo e aquisições | Prazo médio estimado · dias corridos | métrica | ✓ | ✓ | ✓ | ✓ | prazo/faixas (motor.test.ts) |
| 26 | Prazo e aquisições | Prazo médio estimado · dias úteis | métrica | ✓ | — | ✓ | ✓ | prazo/faixas (motor.test.ts) |
| 27 | Prazo e aquisições | Aquisições com e sem risco | métrica | ✓ | — | ✓ | ✓ | — |
| 28 | Prazo e aquisições | Quantidade de aquisições | métrica | ✓ | — | ✓ | ✓ | — |
| 29 | Prazo e aquisições | Taxa de cessão estimada · a.a. | métrica | ✓ | ✓ | ✓ | ✓ | taxa (motor.test.ts) |
| 30 | Inadimplência | Vencidos / DC | métrica | ✓ | — | ✓ | ✓ | denominador (motor.test.ts) |
| 31 | Inadimplência | Vencidos / PL | métrica | ✓ | — | ✓ | ✓ | denominador (motor.test.ts) |
| 32 | Inadimplência | Vencidos > 90 dias | métrica | ✓ | — | ✓ | ✓ | prazo/faixas (motor.test.ts) |
| 33 | Inadimplência | Vencidos > 120 dias | métrica | ✓ | — | ✓ | ✓ | borda da linha (report-row-edges.test.ts) |
| 34 | Faixas de vencidos | Vencidos até 5 dias | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 35 | Faixas de vencidos | Vencidos de 6 a 30 dias | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 36 | Faixas de vencidos | CVM · Até 30 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 37 | Faixas de vencidos | CVM · 31–60 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 38 | Faixas de vencidos | CVM · 61–90 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 39 | Faixas de vencidos | CVM · 91–120 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 40 | Faixas de vencidos | CVM · 121–150 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 41 | Faixas de vencidos | CVM · 151–180 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 42 | Faixas de vencidos | CVM · 181–360 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 43 | Faixas de vencidos | CVM · 361–720 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 44 | Faixas de vencidos | CVM · 721–1080 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 45 | Faixas de vencidos | CVM · >1080 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 46 | Vencimentos | DC a vencer ≤ 30 dias | métrica | ✓ | — | ✓ | ✓ | prazo/faixas (motor.test.ts) |
| 47 | Vencimentos | DC a vencer ≤ 90 dias | métrica | ✓ | — | ✓ | ✓ | prazo/faixas (motor.test.ts) |
| 48 | Vencimento contratual dos DC · CVM | Previsão de caixa até 5 dias | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 49 | Vencimento contratual dos DC · CVM | Previsão de caixa de 6–30 dias | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 50 | Vencimento contratual dos DC · CVM | DC a vencer · Até 30 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 51 | Vencimento contratual dos DC · CVM | DC a vencer · 31–60 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 52 | Vencimento contratual dos DC · CVM | DC a vencer · 61–90 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 53 | Vencimento contratual dos DC · CVM | DC a vencer · 91–120 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 54 | Vencimento contratual dos DC · CVM | DC a vencer · 121–150 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 55 | Vencimento contratual dos DC · CVM | DC a vencer · 151–180 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 56 | Vencimento contratual dos DC · CVM | DC a vencer · 181–360 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 57 | Vencimento contratual dos DC · CVM | DC a vencer · 361–720 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 58 | Vencimento contratual dos DC · CVM | DC a vencer · 721–1080 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 59 | Vencimento contratual dos DC · CVM | DC a vencer · >1080 dias | faixa CVM | ✓ | — | ✓ | ✓ | faixas/prazo (motor.test.ts) |
| 60 | Concentração | Maior cedente listado | métrica | ✓ | — | ✓ | ✓ | concentração (motor.test.ts) |
| 61 | Concentração | Top 5/10/15 cedentes | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 62 | Concentração | Maior sacado / PL | métrica | ✓ | — | ✓ | ✓ | concentração (motor.test.ts) |
| 63 | Concentração | Top 5 sacados / PL | métrica | ✓ | ✓ | ✓ | ✓ | concentração (motor.test.ts) |
| 64 | Concentração | Top 10 sacados / PL | métrica | ✓ | — | ✓ | ✓ | concentração (motor.test.ts) |
| 65 | Concentração | Top 15 sacados / PL | métrica | ✓ | — | ✓ | ✓ | concentração (motor.test.ts) |
| 66 | Recompra | Recompra agregada CVM | métrica | ✓ | — | ✓ | ✓ | borda da linha (report-row-edges.test.ts) |
| 67 | Recompra | Recompra / liquidados | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 68 | Recompra | Baixa por depósito do cedente | lacuna | ✓ | — | ✓ | ✓ | lacuna (coverage.test.ts) |
| 69 | Subordinação | Cotas seniores | métrica | ✓ | — | ✓ | ✓ | subordinação (motor.test.ts) |
| 70 | Subordinação | Cotas mezanino | métrica | ✓ | — | ✓ | ✓ | subordinação (motor.test.ts) |
| 71 | Subordinação | Cotas subordinadas | métrica | ✓ | — | ✓ | ✓ | subordinação (motor.test.ts) |
| 72 | Subordinação | Índice apurado | métrica | ✓ | ✓ | ✓ | ✓ | subordinação (motor.test.ts) |
| 73 | Subordinação | Mínimo parametrizado | métrica | ✓ | — | ✓ | ✓ | subordinação (motor.test.ts) |
| 74 | Subordinação | Folga indicativa | métrica | ✓ | ✓ | ✓ | ✓ | subordinação (motor.test.ts) |

**Sem cobertura estrutural:** nenhum. **Sem cálculo:** 7 lacunas intencionais, listadas como `lacuna` na tabela.
