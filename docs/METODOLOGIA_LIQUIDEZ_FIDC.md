# Metodologia do relatório mensal de liquidez FIDC

**Estado:** implementação de validação, metodologia `cvpar_fidc_mensal@2026.2`. **Público:** Risco, Compliance, Engenharia e auditoria. **Data-base desta revisão:** 24/09/2026.

Este documento descreve o cálculo efetivamente implementado em `supabase/functions/_shared/liquidity-monthly.ts`. É a especificação auditável do relatório mensal. A planilha de Compliance de junho/julho de 2026 foi usada apenas como referência de confronto, nunca como fonte de valores. O objetivo de operação é mais de 50 fundos e AUM acima de R$ 1 bilhão; a validação quantitativa disponível até aqui cobre quatro fundos CVPAR e duas competências. Capacidade e aderência para todo o universo ainda não foram homologadas.

## 1. Pergunta de risco e fronteira

O relatório mensal reproduz a **posição contábil e os indicadores observáveis** no Informe Mensal FIDC da CVM, com uma linha de evidência por indicador. Ele permite acompanhar PL, composição do DC, inadimplência, faixas, movimentação, concentração declarada e subordinação. Vencimento contratual não é recebimento certo: atrasos, pré-pagamentos, horários de liquidação e possibilidade de venda afetam o caixa disponível. Portanto, a soma de liquidez contábil e DC a vencer em 30 dias não mede cobertura de amortizações/resgates nem autoriza classificação automática do risco.

O método do Frame Control Center de vértices, matriz ANBIMA e cobertura operacional é uma trilha separada. O índice de subordinação CVPAR não substitui um índice de cobertura de passivo. O manual operacional da CVPAR pede despesas, lâmina de movimentações, alocação, prazo médio, vencidos, previsão do estoque, concentração e recompra; a política de risco exige confrontar fluxos esperados com obrigações e preservar memória de cálculo. Os dados faltantes para esse confronto estão na seção 6.

## 2. Fontes, chaves e linhagem

| Fonte | Uso | Chave temporal e identificação | Evidência preservada |
|---|---|---|---|
| ZIP público `inf_mensal_fidc_AAAAMM.zip` da CVM | Tabs I, III, IV, V, VI, VII, VIII, IX e X | competência `AAAA-MM` e CNPJ normalizado | ZIP privado, SHA-256, caminho Storage, origem e `registry_sync_log` |
| Carteira Diária CSV da administradora | CPR, despesas, conferência de caixa/ativos | CNPJ e data-base do arquivo | arquivo privado, SHA-256 e resumo de posição |
| Cadastro `funds` | universo monitorado e CNPJ | `cnpj_fundo_master` | cadastro versionável do portal |
| Mínimo de subordinação | comparação indicativa | fundo e vigência do regulamento | parâmetro cadastrado; vigência ainda precisa ser homologada |
| Excel de Compliance | confronto amostral | junho e julho de 2026 | fora da ingestão e do cálculo |

O fluxo é: interface → Edge Function `import-liquidity-monthly-cvm` → Storage privado e `fund_monthly_cvm_filing` → `calculate-liquidity-monthly` → `liquidity_monthly_runs` → Relatório/Painel. O ZIP pode vir por download da CVM ou upload local. A importação é restrita a conta ativa com `profiles.role=risco` ou `user_profiles.access_type=completo`; `profiles.role=compliance` impede escrita. A página consulta os resultados persistidos; a prévia embutida de junho/julho serve para validação e é explicitamente identificada.

Uma reimportação da mesma competência substitui os fatos monitorados dessa competência em transação. A execução registra `running → ok/error` em `ingest_runs`. O relatório guarda código/versão de metodologia, configuração e proveniência. Não se deve misturar ZIPs de competências distintas no mesmo resultado.

## 3. Convenções de cálculo

- Valores monetários são em reais; razões são frações `0…1` e a interface as mostra em percentual.
- `null` significa ausente/indisponível. O motor só soma campos requeridos quando todos estão presentes. Campo opcional ausente na versão 2026.2 entra como zero apenas quando a coluna não existe no registro de Tab I; as demais ausências permanecem `null`.
- Razão com denominador ausente ou zero fica indisponível. Negativos são preservados em PDD, resgates e despesas. A UI não converte indisponível em zero ou “conforme”.
- As etiquetas `apurado`, `aproximado`, `indisponivel` qualificam a **aderência da fonte e fórmula**, não a concordância com a planilha. `Aproximado` não deve entrar em decisão automática de limite sem validação da área de Risco.
- A configuração CVPAR 2026.2 inclui mezanino na subordinação, adiciona cotas FIDC e outros VM ao DC e reverte a PDD para apresentar DC bruto. Essas opções pertencem à metodologia versionada; uma gestora nova não deve herdar a configuração sem homologar seu plano de contas e regulamentos.

## 4. Dicionário de indicadores

| Indicador / chave | Fórmula operacional | Origem | Qualificação |
|---|---|---|---|
| `pl` | `TAB_IV_A_VL_PL` | Tab IV | apurado |
| `pdd` | `-(TAB_I2A11_VL_REDUCAO_RECUP + TAB_I2B11_VL_REDUCAO_RECUP)` | Tab I | apurado; sinal negativo |
| `creditDirectGross` | DC com risco + DC sem risco − PDD negativa | Tab I | apurado |
| `creditGross` | DC com risco + DC sem risco + campos extras configurados − PDD negativa | Tab I | aproximado; composição CVPAR |
| `fidcUnits` | `TAB_I2H + TAB_I2I` | Tab I | apurado |
| `otherCreditVm` | `TAB_I2C1 + I2C2 + I2C3 + I2C4 + I2C6` | Tab I | apurado |
| `creditNetPdd` | DC bruto + PDD negativa | derivado | aproximado; corrige rótulo da planilha |
| `overdue` | `TAB_V_B_VL_DIRCRED_INAD + TAB_VI_B_VL_DIRCRED_INAD` | Tabs V/VI | aproximado; total agregado |
| `creditPerforming` | DC bruto − vencidos | derivado | aproximado |
| `publicBonds` | títulos públicos federais `I2D` + compromissadas `I2F` | Tab I | apurado |
| `fundUnits` | cotas de FIF `I2C5` | Tab I | apurado |
| `cash` | disponibilidades `I1` | Tab I | apurado |
| `immediateLiquidity` | caixa + títulos públicos/compromissadas + FIF | derivado | aproximado; disponibilidade contábil |
| `cprCvm` | outros ativos `I4` + derivativos `I3` − passivo `III` | Tabs I/III | aproximado; não é despesa por natureza |
| `inflow` | `TAB_X_4`, “Captações no Mês” | Tab X.4 | apurado na fonte; pode divergir da lâmina |
| `redemptions` | negativo de resgates + amortizações do mês | Tab X.4 | aproximado; saídas fora da Tab X.4 podem faltar |
| `netFlows` | entradas + saídas assinadas | derivado | aproximado |
| `acquisitions` | `TAB_VII_A1_2 + TAB_VII_A2_2` | Tab VII | apurado; com e sem risco |
| `acquisitionCount` | `TAB_VII_A1_1 + TAB_VII_A2_1` | Tab VII | apurado |
| `repurchaseCvm` | `TAB_VII_D_2` | Tab VII | aproximado; não equivale a recompra/liquidados |
| `subordination` | Σ(quantidade × valor de cota mezanino/subordinada) ÷ PL | Tab X.2 e IV | aproximado; depende do regulamento |
| `subordinationHeadroom` | índice apurado − mínimo cadastrado | derivado | indicativo; sem decisão automática |
| `debtorTop1/5/10/15` | soma dos N maiores `VALOR` da Tab VIII ÷ PL | Tab VIII | aproximado; até 25 linhas, sem prova de consolidação por devedor |
| `cedentListedTop1` | maior percentual declarado em `I2A12/I2B12` ÷ 100 | Tab I | aproximado; até 9 cedentes por grupo |
| Despesas de administração, custódia, gestão e outras negativas | rubricas CPR do resumo da Carteira Diária | CSV posição | aproximado; saldo a pagar não prova despesa incorrida no mês |

Os campos extras do DC na configuração 2026.2 são `I2H`, `I2I`, `I2C1`, `I2C2`, `I2C3`, `I2C4` e `I2C6`, todos com seus nomes completos `TAB_…` no código. I2C6 inclui “outros” valores mobiliários de crédito e pode conter CCB/NC; sua composição precisa ser comprovada por estoque. O caso CVPAR II apresenta R$ 447,15 de diferença de classificação entre DC e CPR em julho.

Razões adicionais seguem `valor ÷ PL` ou `valor ÷ DC bruto` conforme o sufixo da chave (`ToPl`, `ToCredit`). `creditNetPddToPl=(creditGross+pdd)/pl`; a célula de “DC líquido de PDD” do Excel de julho divide DC bruto por PL, inconsistência registrada no confronto.

## 5. Faixas, prazo e painel

As Tabs V/VI_A formam as dez faixas de **vencimento contratual**: até 30, 31–60, 61–90, 91–120, 121–150, 151–180, 181–360, 361–720, 721–1080 e acima de 1080 dias. As Tabs V/VI_B formam as faixas de inadimplência. O informe não separa até 5 de 6–30 dias. `due30` é a primeira faixa; `due90` soma as três primeiras. `overdue90` soma B4…B10; `overdue120` soma B5…B10.

O prazo médio estimado é `Σ(valor_faixa × ponto_médio_faixa) ÷ Σ(valor_faixa)`, com pontos [15, 45, 75, 105, 135, 165, 270, 540, 900, 1080] dias corridos. A última faixa aberta usa 1080 como limite inferior. A aproximação de dias úteis multiplica por `252/365`, sem feriados. A taxa de cessão anual usa a média ponderada das taxas de compra da Tab IX pelos montantes adquiridos da Tab VII; taxas ausentes ou fora de (0; 300]% a.a. são excluídas. A taxa mensal é `(1+taxa_anual)^(1/12)-1`.

O Painel mostra composição por faixa, concentração e subordinação; a curva acumulada soma liquidez imediata contábil e DC por vencimento e limita a visualização a 100% do PL. Essa limitação é apenas visual. Valores acima de 100% e déficits não devem ser interpretados por essa curva isoladamente. A coluna `status` de cada linha e a memória de origem prevalecem sobre qualquer cor/alerta do cartão.

## 6. Lacunas que impedem um fechamento completo

1. **Estoque título a título:** prazo exato, 0–5 e 6–30 dias, previsão de caixa, identidade/consolidação de sacados e todos os cedentes.
2. **Lâmina e arquivo de títulos liquidados:** conciliação de entradas/saídas, recompra como percentual dos liquidados, baixa por depósito e outras liquidações.
3. **Passivo e obrigações:** cotistas, janelas de cotização/pagamento, amortizações programadas, despesas e garantias para descasamento ativo/passivo e stress.
4. **Net Report/Carteira Diária em todas as datas:** despesas por natureza e posição CPR completa.
5. **Regulamento vigente por fundo/classe:** mínimo de subordinação, inclusão de mezanino, critérios e vigência. Os percentuais 5/15/40/10% são parâmetros da amostra, não regra universal.

Até resolver essas lacunas, o risco de liquidez final fica **inconclusivo**. Não transformar dado ausente em zero, baixo risco ou conformidade. A `TAB_X_5` e a recompra agregada da CVM não substituem o fluxo detalhado do estoque.

## 7. Confronto e controle de versões

A validação amostral e as divergências monetárias estão em [VALIDACAO_LIQUIDEZ_CVPAR_2026.md](VALIDACAO_LIQUIDEZ_CVPAR_2026.md). Junho/julho dos quatro fundos produziram 73/80 indicadores-base dentro de R$ 0,05 ou 0,01 ponto percentual de inspeção. Esse limiar é apenas de teste, não tolerância de produção. As divergências incluem vencidos EDUC, saídas ausentes, entradas do CVPAR I e classificação de R$ 447,15 no CVPAR II. Alterar regra exige nova versão imutável da metodologia, novo cálculo e confronto por competência; não reescrever silenciosamente execuções anteriores.

O dicionário das linhas da planilha original e suas fórmulas está em [MAPEAMENTO_PLANILHA_LIQUIDEZ.md](MAPEAMENTO_PLANILHA_LIQUIDEZ.md). Ele documenta a referência de teste; o presente documento e o código versionado definem o cálculo da base CVM.

## 8. Preparação para mais de 50 fundos

O filtro atual seleciona CNPJs de `funds`; não há CNPJ fixo no motor. Para ampliar o universo, cadastrar cada fundo, validar CNPJ e classe, aprovar limites por vigência, importar competência, contar tabelas/fundos encontrados e comparar totais de controle. Separar falha de um fundo do sucesso dos demais e manter histórico de reprocessamento por hash. Antes de uso recorrente com mais de 50 fundos, medir tempo, memória e volume dos ZIPs reais, pois o importador atual carrega o ZIP inteiro em memória e usa uma transação por competência. Caso a carga exceda a capacidade medida, particionar por fundo/lote e usar fila com retomada idempotente e manifestos completos.

Na amostra de oito fundos, o log do importador registrou 2,5 s em junho (187.166 linhas lidas) e 3,0 s em julho (189.528 linhas lidas). São medições de duas execuções, não benchmark de capacidade. Em 24/09/2026, 16 cálculos persistidos (oito fundos × dois meses) foram confrontados com a prévia local dos ZIPs originais em 13 indicadores por execução: 208/208 sem diferença numérica. A prévia usa o mesmo parser e motor; este confronto verifica ingestão e persistência, enquanto a revisão independente das fórmulas continua baseada no Excel e nas fontes. Não prova o risco final nem desempenho com 50 fundos.

O banco vinculado é o fork `gwdtyorogmfijleoydvm`, confirmado pelo usuário. Ele não é um ambiente multi-gestora isolado por tenant. Para atender gestoras diferentes na mesma instância, acrescentar `tenant_id` a todas as tabelas, funções, logs e objetos Storage, políticas RLS por tenant, e testar isolamento cruzado. Até lá, usar instâncias separadas para outras gestoras. A meta de AUM não altera as fórmulas, mas exige revisão formal de RBAC, reconciliação, observabilidade, retenção de evidências, recuperação de falhas e homologação por Risco/Compliance antes de fechamento oficial.

**Limite atual da interface:** o importador filtra todos os CNPJs cadastrados em `funds`; o relatório consulta o cadastro ativo e os meses importados. Há busca por nome/CNPJ, seleção em massa e páginas de até dez fundos no relatório e nos gráficos. O cálculo oferece todos os cadastrados em lotes concorrentes de quatro. A consulta atual do cadastro tem limite de 500 registros; antes de ultrapassá-lo, paginar a leitura. Para operação com mais de 50 fundos, ainda faltam filtro por gestora/classe, exportação, teste de carga com ZIPs reais e monitoramento de tempo/memória/erros por lote. O banco/motor não devem ser declarados homologados para essa escala com base nos oito fundos calculados em junho e julho.

## 9. Operação e aceite mensal

1. Entrar em **Dados → Importar → Informes CVM** com conta ativa de Risco ou acesso completo.
2. Selecionar a competência correta e importar da CVM ou enviar o ZIP original (até 15 MB para upload local). A resposta da importação informa os CNPJs encontrados; a interface chama `calculate-liquidity-monthly` para esses fundos em lotes de quatro e mostra quantos cálculos terminaram. A importação pode concluir mesmo que algum cálculo falhe: nesse caso, a mensagem separa o sucesso da carga das falhas por CNPJ e oferece recálculo manual. Conferir também `ingest_runs`; falha não deve ser tratada como carga concluída.
3. Em **Liquidez → FIDC mensal → Dados e parâmetros**, carregar a Carteira Diária pertinente, se houver, e recalcular os fundos que usam essa posição. O cálculo automático após o ZIP usa apenas o informe e as posições já carregadas no momento; a importação posterior de uma Carteira Diária exige recálculo para incorporá-la.
4. Conferir quantidade de fundos, tabelas, hashes, PL, PDD, DC, vencidos, caixa, fluxos e subordinação; explicar cada diferença material contra fontes independentes. Registrar quem revisou e aprovou.
5. Publicar fechamento somente quando gaps críticos, parâmetros vigentes e passivo/estoque necessários à finalidade de risco estiverem resolvidos. A prévia ou o relatório contábil isolado não são aprovação de liquidez.

### Exportação do relatório

O botão **Exportar** em `/liquidez/mensal` usa a competência, a origem e **todos os fundos selecionados**, inclusive os que não aparecem na página atual da matriz. O filtro de linhas da interface não corta o arquivo: ambos os formatos levam todas as linhas do relatório para preservar a memória completa. A origem (Base do portal ou Prévia CVM), a versão `cvpar_fidc_mensal@2026.2` e qualquer mínimo de subordinação simulado localmente são identificados no arquivo. Exportações são fotografias dos valores calculados; o Excel não recalcula a metodologia nem alimenta o banco.

O **PDF** apresenta um fundo por vez, com indicadores, qualidade da linha, ressalvas e lacunas, em páginas A4 com a paleta institucional. O **Excel** contém as abas `Relatório` (valores numéricos, percentuais e `n/d` explícito), `Memória e fontes`, `Lacunas`, `Metadados` e `Comparativo` quando a comparação mensal estiver ativada. Esses arquivos servem para análise e revisão; não eliminam as dependências de estoque, passivo e homologação descritas acima.
