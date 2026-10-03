# Mapeamento da planilha mensal de liquidez

Extração de 17/09/2026, somente leitura do OOXML. Fórmulas e valores gravados foram lidos; o Excel não foi recalculado. Nenhum arquivo original foi alterado. Fonte: `RELATÓRIO COMPLIANCE_FIDC_2026 (1).xlsx`.

## Estrutura

7 abas, janeiro–julho/2026; C = CVPAR EDUC, D = CVPAR I, E = CVPAR II, F = CVPAR NC; 28 observações fundo/mês. Cada aba possui 82 linhas numéricas por fundo (328 células), incluindo repetições. Não foram encontrados erros Excel armazenados nas células; isso não prova que as regras estejam corretas.

| Aba | Fórmulas totais, inclusive rótulos | Células numéricas sem fórmula |
|---|---:|---:|
| JANEIRO | 81 | 249 |
| FEVEREIRO | 81 | 249 |
| MARÇO | 81 | 249 |
| ABRIL | 80 | 250 |
| MAIO | 81 | 249 |
| JUNHO | 82 | 248 |
| JULHO | 82 | 248 |

## Dicionário completo de linhas

Os campos abaixo em crase correspondem aos nomes já existentes em `src/types/database.ts`, na interface `LiquidityReport`; 61 correspondências. As outras linhas são apresentação/repetição/derivação ou parâmetro. A origem operacional é uma proposta a comprovar com arquivos reais, não uma integração já validada. Percentuais armazenados como frações; não multiplicar duas vezes por 100.

Fórmulas são as efetivamente presentes em JULHO, por coluna. “constante” significa sem fórmula nesta célula; não pressupõe regra geral. Os meses anteriores foram lidos e submetidos às conciliações especificadas abaixo.

| Linha | Indicador original | Unidade | Destino existente / tratamento | C / D / E / F em julho | Fonte a homologar |
|---|---|---|---|---|---|
| 5 | Taxa de Administração | R$ | `despesa_taxa_administracao` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 6 | Taxa de Custódia | R$ | `despesa_taxa_custodia` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 7 | Taxa de Gestão | R$ | `despesa_taxa_gestao` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 8 | Despesas SELIC  /  ANBID  /  CETIP  /  BOVESPA  /  ANBIMA  /  LIQ | R$ | `despesa_selic_anbid_cetip_bovespa_anbima` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 9 | Resgate/Amortização/IOF | R$ | `despesa_resgate_amortizacao_iof` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 10 | Outras Despesas | R$ | `despesa_outras` | C: constante; D: constante; E: constante; F: constante | Demonstrativo de despesas do mês; não saldo de provisão |
| 13 | Saídas | R$ | `mov_saidas` | C: constante; D: constante; E: constante; F: constante | Movimentações efetivas da competência |
| 14 | Entradas | R$ | `mov_entradas` | C: constante; D: constante; E: constante; F: constante | Movimentações efetivas da competência |
| 15 | Captações Líquidas | R$ | `mov_captacoes_liquidas` | C: `SUM(C13:C14)`; D: `SUM(D13:D14)`; E: `SUM(E13:E14)`; F: constante | Movimentações efetivas da competência |
| 18 | Patrimônio Líquido | R$ | `pl` | C: constante; D: constante; E: constante; F: constante | Posição/contabilidade da data-base; conciliar com CVM |
| 19 | Volume em Direitos Creditórios Total | R$ | `volume_dc_total` | C: `SUM(C20:C21)`; D: constante; E: `SUM(E20:E21)`; F: `F20+F21` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 20 | (1) Volume de DC Vencidos | R$ | `volume_dc_vencidos` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 21 | (2) Volume de DC A Vencer | R$ | `volume_dc_a_vencer` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 22 | Títulos Públicos  /  Compromissadas | R$ | `titulos_publicos_compromissadas` | C: constante; D: constante; E: constante; F: constante | Posição/contabilidade da data-base; conciliar com CVM |
| 23 | Despesas  /  CPR | R$ | `despesas_cpr` | C: constante; D: constante; E: constante; F: constante | Posição/contabilidade da data-base; conciliar com CVM |
| 24 | Valor PDD | R$ | `valor_pdd` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 25 | Volume em Direitos Creditórios | R$ | Derivado/apresentação; não duplicar fato | C: `C19`; D: `D19`; E: `E19`; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 26 | Ativos de Liquidez  /  RF  /  Zeragem | R$ | `ativos_liquidez_rf_zeragem` | C: constante; D: constante; E: constante; F: constante | Posição/contabilidade da data-base; conciliar com CVM |
| 27 | Saldo Tesouraria  /  Caixa | R$ | `saldo_tesouraria` | C: constante; D: constante; E: constante; F: constante | Posição/contabilidade da data-base; conciliar com CVM |
| 28 | Patrimônio Líquido | fração (%) | Derivado/apresentação; não duplicar fato | C: `C18/$C$18`; D: `D18/$D$18`; E: `E18/$E$18`; F: `F18/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 29 | Volume em Direitos Creditórios Total | fração (%) | Derivado/apresentação; não duplicar fato | C: `C19/$C$18`; D: `D19/$D$18`; E: `E19/$E$18`; F: `F19/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 30 | Valor PDD | fração (%) | Derivado/apresentação; não duplicar fato | C: `C24/$C$18`; D: `D24/$D$18`; E: `E24/$E$18`; F: `F24/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 31 | Volume em Direitos Creditórios Líquido PDD | fração (%) | Derivado/apresentação; não duplicar fato | C: `C25/$C$18`; D: `D25/$D$18`; E: constante; F: `F25/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 32 | Ativos de Liquidez  /  RF  /  Zeragem | fração (%) | Derivado/apresentação; não duplicar fato | C: `C26/$C$18`; D: `D26/$D$18`; E: constante; F: `F26/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 33 | Saldo Tesouraria  /  Caixa | fração (%) | Derivado/apresentação; não duplicar fato | C: `C27/$C$18`; D: `D27/$D$18`; E: constante; F: `F27/$F$18` | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 34 | Prazo Médio Direitos Creditórios  /  Dias úteis | dias úteis | `prazo_medio_dc_dias_uteis` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 35 | Prazo Médio Direitos Creditórios  /  Dias corridos | dias corridos | `prazo_medio_dc_dias_corridos` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 36 | Aquisições No Mês | R$ | `aquisicoes_no_mes` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 37 | Taxa de Cessão DC | fração (%) | `taxa_cessao_dc` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 38 | Taxa de Cessão DU | fração (%) | `taxa_cessao_du` | C: constante; D: constante; E: constante; F: constante | Estoque analítico, posição e aquisições; método/peso a confirmar |
| 41 | Valor PDD | R$ | Derivado/apresentação; não duplicar fato | C: `C24`; D: constante; E: `E24`; F: `F24` | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 42 | índice de PDD (%) de Direitos Creditórios | fração (%) | `indice_pdd_sobre_dc` | C: `C41/C19`; D: `D41/D19`; E: `E41/E19`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 43 | índice de PDD (%) do Patrimônio Líquido | fração (%) | `indice_pdd_sobre_pl` | C: `C41/C18`; D: `D41/D18`; E: `E41/E18`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 44 | Valor de Vencidos Total | R$ | `valor_vencidos_total` | C: `C50`; D: `D50`; E: `E50`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 45 | Vencidos (%) dos Direitos Creditórios | fração (%) | `vencidos_pct_dc` | C: `C44/C19`; D: `D44/D19`; E: `E44/E19`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 46 | Vencidos (%) do Patrimônio Líquido | fração (%) | `vencidos_pct_pl` | C: `C44/C18`; D: `D44/D18`; E: `E44/E18`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 47 | Vencidos a mais de 120 Dias | R$ | `vencidos_acima_120d` | C: `C56`; D: `D56`; E: `E56`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 48 | Vencidos > 120 Como (%) dos Direitos Creditórios | fração (%) | Derivado/apresentação; não duplicar fato | C: `C47/C19`; D: `D47/D19`; E: `E47/E19`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 49 | Vencidos > 120 Como (%) do Patrimônio Líquido | fração (%) | Derivado/apresentação; não duplicar fato | C: `C47/C18`; D: `D47/D18`; E: `E47/E18`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 50 | Faixa de Vencimentos | R$ | Derivado/apresentação; não duplicar fato | C: `SUM(C51:C56)`; D: `SUM(D51:D56)`; E: `SUM(E51:E56)`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 51 | (A)  /  Vencidos até 5 dias | R$ | `faixa_vencidos_ate_5d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 52 | (B)  /  Vencidos DE 6 a 30 dias | R$ | `faixa_vencidos_6_30d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 53 | (C)  /  Vencidos DE 31 a 60 dias | R$ | `faixa_vencidos_31_60d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 54 | (D)  /  Vencidos DE 61 a 90 dias | R$ | `faixa_vencidos_61_90d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 55 | (E)  /  Vencidos DE 91 a 120 dias | R$ | `faixa_vencidos_91_120d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 56 | (F)  /  Vencidos Acima de 120 dias | R$ | `faixa_vencidos_acima_120d` | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 57 | Faixa de Vencimentos (%) do PL | fração (%) | Derivado/apresentação; não duplicar fato | C: `SUM(C58:C63)`; D: `SUM(D58:D63)`; E: `SUM(E58:E63)`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 58 | (A)  /  Vencidos até 5 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: `C51/$C$50`; D: `D51/$D$50`; E: `E51/$E$50`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 59 | (B)  /  Vencidos DE 6 a 30 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: constante; D: `D52/$D$50`; E: `E52/$E$50`; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 60 | (C)  /  Vencidos DE 31 a 60 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 61 | (D)  /  Vencidos DE 61 a 90 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 62 | (E)  /  Vencidos DE 91 a 120 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 63 | (F)  /  Vencidos Acima de 120 dias | fração (%) | Derivado/apresentação; não duplicar fato | C: constante; D: constante; E: constante; F: constante | Estoque analítico + PDD + vencimentos; base DU/DC a confirmar |
| 66 | VOLUME TOTAL DE FIDCs | R$ | `volume_total_fidcs` | C: `SUM(C67:C76)`; D: `SUM(D67:D76)`; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 67 | (A)  /  Previsão de Liquidação até 5 dias | R$ | `prev_liq_ate_5d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 68 | (B)  /  Previsão de Liquidação de 6 a 30 dias | R$ | `prev_liq_6_30d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 69 | (C)  /  Previsão de Liquidação de 31 a 60 dias | R$ | `prev_liq_31_60d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 70 | (D)  /  Previsão de Liquidação de 61 a 90 dias | R$ | `prev_liq_61_90d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 71 | (E)  /  Previsão de Liquidação de 91 a 120 dias | R$ | `prev_liq_91_120d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 72 | (F)  /  Previsão de Liquidação de 121 a 180 dias | R$ | `prev_liq_121_180d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 73 | (G)  /  Previsão de Liquidação de 181 a 240 dias | R$ | `prev_liq_181_240d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 74 | (H)  /  Previsão de Liquidação de 241 a 300 dias | R$ | `prev_liq_241_300d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 75 | (I)  /  Previsão de Liquidação de 301 a 365 dias | R$ | `prev_liq_301_365d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 76 | (J)  /  Previsão de Liquidação acima de 365 dias | R$ | `prev_liq_acima_365d` | C: constante; D: constante; E: constante; F: constante | Fluxos/vencimentos individuais; base de valor a confirmar |
| 79 | TOP_1 | fração (%) | `conc_cedentes_top1` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 80 | TOP_5 | fração (%) | `conc_cedentes_top5` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 81 | TOP_10 | fração (%) | `conc_cedentes_top10` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 82 | TOP_15 | fração (%) | `conc_cedentes_top15` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 85 | TOP_1 | fração (%) | `conc_sacados_top1` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 86 | TOP_5 | fração (%) | `conc_sacados_top5` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 87 | TOP_10 | fração (%) | `conc_sacados_top10` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 88 | TOP_15 | fração (%) | `conc_sacados_top15` | C: constante; D: constante; E: constante; F: constante | Estoque com cedente/sacado; agrupamento/base a confirmar |
| 91 | Patrimônio Líquido | R$ | Derivado/apresentação; não duplicar fato | C: `C18`; D: constante; E: `E18`; F: `F18` | Extrato de baixas/recompras do mês; eventos a classificar |
| 92 | Volume em Direitos Creditórios | R$ | Derivado/apresentação; não duplicar fato | C: constante; D: constante; E: `E19`; F: `F19` | Extrato de baixas/recompras do mês; eventos a classificar |
| 93 | Baixa Por Depósito Cedente | R$ | `baixa_deposito_cedente` | C: constante; D: constante; E: constante; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 94 | Baixa Por Recompra | R$ | `baixa_recompra` | C: constante; D: constante; E: constante; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 95 | Recompra Parcial Sem Adiantamento | R$ | `recompra_parcial_sem_adiantamento` | C: constante; D: constante; E: constante; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 96 | Outras Liquidações | R$ | `outras_liquidacoes` | C: constante; D: constante; E: constante; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 97 | Índice de Recompra Como (%) dos Liquidados | fração (%) | `indice_recompra_pct_liquidados` | C: constante; D: `SUM(D93:D95)/SUM(D93:D96)`; E: `SUM(E93:E95)/SUM(E93:E96)`; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 98 | Índice de Recompra Como (%) do PL | fração (%) | `indice_recompra_pct_pl` | C: `SUM(C93:C95)/C91`; D: `SUM(D93:D95)/D91`; E: `SUM(E93:E95)/E91`; F: constante | Extrato de baixas/recompras do mês; eventos a classificar |
| 101 | Índice de Subordinação | fração (%) | `indice_subordinacao` | C: constante; D: constante; E: constante; F: constante | Composição das cotas e regulamento/política vigente |
| 102 | Índice Mínimo | fração (%) | Parâmetro mínimo por fundo com vigência; hoje `funds.min_subordination_index` | C: constante; D: constante; E: constante; F: constante | Composição das cotas e regulamento/política vigente |

## Conciliações executadas nas sete abas

Comparações: total DC vs vencidos + a vencer; volume previsto vs soma das dez faixas; vencidos da posição vs total da seção de inadimplência; índice de recompra vs expressão observada nas demais colunas; concentração acima de 100%. Para localizar diferenças, foram usados R$ 0,01 e 0,000001 em fração como limiares de inspeção, não tolerâncias financeiras aprovadas. Nenhuma divergência foi corrigida. Bases diferentes podem explicar diferenças.

| Aba | Fundo | Verificação | Células | Valor A | Valor B |
|---|---|---|---|---:|---:|
| JANEIRO | CVPAR I | DC vencidos vs total vencido | D20 / D44 | 8.236.766,44 | 8.236.905,8 |
| JANEIRO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00149797 | 1,00149797 |
| FEVEREIRO | CVPAR II | DC vencidos vs total vencido | E20 / E44 | 7.016.131,26395202 | 6.857.231,78 |
| FEVEREIRO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00100821 | 1,00100821 |
| MARÇO | CVPAR EDUC | Recompra / liquidados vs fórmula das demais colunas | C97 / C93:C96 | 0 | 0,57842726 |
| MARÇO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00099841 | 1,00099841 |
| ABRIL | CVPAR EDUC | Recompra / liquidados vs fórmula das demais colunas | C97 / C93:C96 | 0 | 0,1288137 |
| ABRIL | CVPAR I | DC vencidos vs total vencido | D20 / D44 | 218.426,27 | 218.426,31 |
| ABRIL | CVPAR II | DC vencidos vs total vencido | E20 / E44 | 4.613.047,44395202 | 4.613.047,72 |
| ABRIL | CVPAR NC | Total DC vs soma | F19 / F20:F21 | 50.348.520,2 | 49.538.930,99 |
| ABRIL | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00099841 | 1,00099841 |
| MAIO | CVPAR EDUC | Recompra / liquidados vs fórmula das demais colunas | C97 / C93:C96 | 0 | 0,10481658 |
| MAIO | CVPAR I | DC vencidos vs total vencido | D20 / D44 | 3.152.741,79 | 3.152.741,83 |
| MAIO | CVPAR II | DC vencidos vs total vencido | E20 / E44 | 3.175.026,79395202 | 2.954.773,54 |
| MAIO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00060541 | 1,00060541 |
| JUNHO | CVPAR EDUC | Recompra / liquidados vs fórmula das demais colunas | C97 / C93:C96 | 0 | 0,04064274 |
| JUNHO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00063518 | 1,00063518 |
| JULHO | CVPAR EDUC | DC vencidos vs total vencido | C20 / C44 | 89.254,25 | 174.063,04 |
| JULHO | CVPAR EDUC | Recompra / liquidados vs fórmula das demais colunas | C97 / C93:C96 | 0 | 0,39539509 |
| JULHO | CVPAR NC | Concentração acima de 100%; base a validar | F79 / F85 | 1,00063518 | 1,00063518 |

Para recompra, A é o valor gravado e B a expressão soma(93:95)/soma(93:96), em fração. Para concentração, A/B são os top 1 de cedentes/sacados; ambos acima de 1 requerem validação da base, sem indicar automaticamente erro. Não houve diferença superior a R$ 0,01 entre o total da linha 66 e a soma das linhas 67:76 nesta inspeção.

## Decisões adicionais de método

- JULHO B57 diz % do PL, mas C58 referencia C50 (total de vencidos), não C18 (PL).
- JULHO C25 repete C19; C31 divide C25 pelo PL, embora o rótulo diga líquido PDD. Confirmar se o saldo de origem já é líquido.
- JULHO C67:F76 contém R$, embora B65 mencione percentual. O relatório deve mostrar unidade explícita.
- Concentração por cedente/sacado não mede concentração de cotistas. Para stress de resgates, é necessária a base de passivo.
- Índice de subordinação, taxas de cessão e prazos médios são valores sem fórmula na amostra mensal. Exigir memória de preparação e regulamentos.
- As faixas CVPAR até 5 dias / 6–30 dias não podem ser recuperadas exatamente de um bucket CVM agregado até 30 dias. Usar estoque/fluxo analítico.
- Totais como PL são posições da data-base; despesas, entradas, saídas e recompras são fluxos do mês. Não somar PL diário para produzir PL mensal.

Consultar o [plano de implementação](PLANO_LIQUIDEZ_CVPAR.md) para arquitetura, fontes e critérios de aceite.
