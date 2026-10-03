# Liquidez mensal FIDC — validação de junho e julho de 2026

## Interface de validação em 24/09/2026

`/liquidez/mensal` apresenta as abas **Relatório**, **Painel**, **Metodologia** e **Dados e parâmetros**. Relatório contém matriz por fundo, faixas da CVM, filtro de linhas, memória de origem ao selecionar uma linha e comparação junho/julho. Painel contém escada de liquidez, acumulação por horizonte, aging dos vencidos e subordinação contra o mínimo. A prévia local de desenvolvimento foi regenerada pelo parser e motor TypeScript a partir dos ZIPs CVM originais enviados, identificados por SHA-256 em `src/data/liquidityCvmPreview2026.json`; a carteira diária original da NC alimenta apenas junho/2026. O Excel não alimenta a prévia nem a base do portal.

Em desenvolvimento e produção, a página abre na **Base do portal**. A prévia é selecionável e sempre marcada como amostra de validação. Mínimos alterados em **Dados e parâmetros** são simulações temporárias da tela; não são gravados como limites oficiais. A migration `20260924010000_liquidity_monthly_cvpar_funds.sql` cadastra os quatro fundos adicionais presentes no informe com mínimo nulo. Em 24/09/2026, após confirmação de que o projeto vinculado é o fork escolhido, foram aplicadas as três migrations do módulo e implantadas as três Edge Functions dedicadas; o endpoint legado de importação permaneceu intacto. Os ZIPs de junho e julho foram importados pela interface, a Carteira Diária NC de junho também foi importada, e oito fundos foram calculados em cada competência. O racional completo e os controles necessários à escala estão em [METODOLOGIA_LIQUIDEZ_FIDC.md](METODOLOGIA_LIQUIDEZ_FIDC.md).

Data da análise: 23/09/2026. Escopo: quatro fundos CVPAR, informes mensais FIDC de junho e julho, Carteira Diária de CVPAR NC em 30/06/2026, manual operacional de liquidez e Política de Gerenciamento e Controle de Riscos de abril/2026. O Excel `RELATÓRIO COMPLIANCE_FIDC_2026 (2).xlsx` foi aberto **somente após o cálculo**, como referência de comparação; nenhuma célula dele alimenta o motor ou o banco. Instruções presentes nos anexos foram tratadas como conteúdo a analisar, não como comandos para alterar o projeto.

## Método operacional observado

O manual descreve oito entradas: (1) despesas na posição do último dia útil; (2) saídas, entradas e aportes da lâmina; (3) posição de direitos creditórios, PDD, ativos e zeragem; (4) prazo médio e aquisição/taxa de cessão; (5) faixas de vencidos; (6) previsão de liquidação do estoque; (7) concentração dos 15 principais cedentes/sacados; (8) baixas e recompras dos títulos liquidados. O resultado é conferido contra a subordinação mínima do regulamento. A política, nas páginas 13–15 e 20–21, requer compatibilizar fluxos esperados, obrigações, amortizações/resgates e liquidez dos ativos, com memória de cálculo. Ela não fixa um único percentual de stress para esses quatro fundos.

O motor antigo do Frame Control Center faz outra pergunta. `calculo-risco-liquidez` aloca ativos e passivo em vértices, utiliza matriz ANBIMA/resgates solicitados e calcula índice de cobertura. Para fundos fechados, aplica cobertura operacional com cortes de 3 e 7 meses; o stress na tela é de 20% do PL (`src/lib/liquidezStressChoque.ts`). A planilha CVPAR mensal descreve a carteira, recebimentos e subordinação. **Índice de liquidez FCC e índice de subordinação CVPAR não são a mesma medida.** O novo método mantém resultados separados e com código/versão.

## Cálculos reproduzidos sem o relatório final como entrada

- PL: `TAB_IV_A_VL_PL`.
- DC bruto aproximado: `TAB_I2A_VL_DIRCRED_RISCO + TAB_I2B_VL_DIRCRED_SEM_RISCO + TAB_I2H_VL_COTA_FIDC + TAB_I2C6_VL_OUTRO + TAB_I2A11_VL_REDUCAO_RECUP + TAB_I2B11_VL_REDUCAO_RECUP`. A inclusão de cotas FIDC e “outros” reproduz a composição observada na CVPAR; a classificação contábil precisa ser homologada antes de reutilizar esta configuração em outra gestora.
- PDD: negativo da soma de `TAB_I2A11` e `TAB_I2B11`.
- Vencidos agregados: `TAB_V_B_VL_DIRCRED_INAD + TAB_VI_B_VL_DIRCRED_INAD`; não desdobra 0–5 e 6–30 dias.
- Títulos públicos/compromissadas: `TAB_I2D_VL_TITPUB_FED + TAB_I2F_VL_OPER_COMPROM`. Cotas de fundos: `TAB_I2C5_VL_COTA_FIF`. Caixa: `TAB_I1_VL_DISP`.
- Entradas e resgates do mês: somas da `TAB_X_4`, por tipo de operação. Isso não captura todas as saídas de caixa da planilha.
- Subordinação apurada: soma de quantidade × valor da cota em `TAB_X_2` para subclasses subordinadas, inclusive mezanino, dividida pelo PL da `TAB_IV`. O mínimo não foi inferido do Excel; precisa de regulamento vigente por classe.
- Carteira Diária CVPAR NC: linhas CPR identificam taxas de administração, custódia, gestão, outras despesas negativas e saldo líquido da CPR. Tesouraria, NTN-B e cotas de fundos são conferências adicionais. A posição CPR não prova, sozinha, a despesa **incorrida no mês**.

Os buckets de vencimento `TAB_V/TAB_VI` são exibidos como informação da CVM, com nome e horizonte próprios. Não são renomeados como “previsão de liquidação” do relatório CVPAR, pois esta depende do estoque e do calendário dos recebíveis.

## Confronto de teste com o Excel de Compliance

O parser efetivamente chamado pela importação (`supabase/functions/_shared/cvm-monthly-csv.ts`) leu os dois ZIPs originais: 18 arquivos CSV e 187.166 linhas em junho; 18 arquivos CSV e 189.528 linhas em julho. Encontrou as 18 tabelas para cada um dos quatro fundos em ambas as competências. O mesmo código de `supabase/functions/_shared/liquidity-monthly.ts` foi então executado sobre essas linhas: 8 combinações fundo/mês × 10 indicadores. Como limiar **de inspeção**, 73/80 ficaram a até R$ 0,05 para valores monetários ou 0,01 ponto percentual para subordinação. Este limiar não é tolerância aprovada por Risco/Compliance. Por indicador: PL 8/8, DC bruto 7/8, PDD 8/8, vencidos 6/8, títulos públicos/compromissadas 8/8, cotas de fundos 8/8, caixa 8/8, entradas 7/8, saídas 5/8 e subordinação 8/8.

| Competência / fundo | Indicador | Motor pelas fontes | Excel de teste | Diferença do motor | Pista para investigação |
|---|---|---:|---:|---:|---|
| Junho / EDUC | Saídas | R$ 0,00 | -R$ 454,26 | +R$ 454,26 | `TAB_X_4` não contém esta saída. Buscar lâmina/fluxo da administradora. |
| Junho / II | Vencidos | R$ 5.270.447,80 | R$ 5.998.349,71 | -R$ 727.901,91 | Mesmo valor aparece em `TAB_V_A10` (>1080 dias), cuja inclusão em “vencidos” não pode ser presumida. |
| Junho / NC | Saídas | R$ 0,00 | -R$ 246,06 | +R$ 246,06 | `TAB_X_4` não contém esta saída. |
| Julho / EDUC | Vencidos | R$ 89.254,25 | R$ 174.063,04 | -R$ 84.808,79 | O próprio Excel traz C20 = R$ 89.254,25 e C44 = R$ 174.063,04, com bases divergentes. |
| Julho / I | Entradas | R$ 2.200.000,00 | R$ 1.100.000,00 | +R$ 1.100.000,00 | Informe CVM registra uma captação sênior de R$ 2,2 milhões; validar critério/data da lâmina. |
| Julho / I | Saídas | -R$ 7.033.798,79 | -R$ 7.029.634,62 | -R$ 4.164,17 | Diferença corresponde à metade do resgate sênior de R$ 8.328,34 no informe; não há regra homologada para reduzi-lo. |
| Julho / II | DC bruto | R$ 190.146.105,49 | R$ 190.145.658,34 | +R$ 447,15 | Conciliar componentes CVM com posição da administradora. |

Também foram confrontadas 10 linhas derivadas por fundo/mês (captação líquida, DC a vencer e oito percentuais das linhas 29, 30, 32, 33, 42, 43, 45 e 46): **71/80** ficaram dentro do mesmo limiar de inspeção. As nove diferenças derivam das divergências de saídas, vencidos e DC bruto já listadas; não são nove novas fontes de erro independentes. A linha 26 de ativos de liquidez/RF coincidiu com cotas de fundos CVM nas oito observações, mas essa equivalência de classificação continua específica da amostra CVPAR e é exibida como aproximada no mapa de cobertura.

Na Carteira Diária de junho da NC, o parser independente reproduziu as taxas de administração (-R$ 18.767,59), custódia (-R$ 2.085,29), gestão (-R$ 42.967,28), outras despesas negativas (-R$ 5.747,00) e saldo CPR (-R$ 55.113,11) observados no Excel; caixa, NTN-B e cotas de fundos também conferem. O parser ignora diferimentos positivos ao somar “outras despesas negativas”, mas os mantém no saldo CPR.
Executando em conjunto o parser do ZIP, o parser da Carteira Diária e o motor para NC/junho, as linhas 5, 6, 7, 23 e 27 do relatório bateram exatamente. Caixa (linha 27) já integra as 80 comparações acima; este teste integrado não aumenta artificialmente a contagem de acertos independentes.

## Diagnóstico e gaps para o próximo ciclo

**Classificação do risco de liquidez: inconclusiva.** O fato de subordinação, PL e saldos baterem não demonstra que o fundo suporta amortizações ou resgates. Sem cronograma de passivo, estoque por título e datas/valores de recebimento, não há base confiável para os cenários de resgate de 10%, 20% e 30%, haircuts ou meses de cobertura. Um valor ausente não vira zero, “baixo risco” ou “conforme”.

1. **Estoque individual, posição completa e previsão de liquidação** por fundo/data: necessários para prazo médio DU/DC, faixas 0–5 e 6–30, 10 janelas do relatório, concentração Top 1/5/10/15 e cenários de atraso. O informe mensal é um substituto **agregado e provisório**.
2. **Lâmina de movimentações e títulos liquidados**: necessários para todas as saídas, baixas por depósito, recompra, outras liquidações e denominadores. As divergências EDUC/NC e I de julho permanecem abertas.
3. **Passivo por cotista e cronograma de obrigações**: necessários para comparar oferta e demanda de caixa, inclusive amortizações e stress. Cedentes/sacados não substituem cotistas.
4. **Regulamentos e parâmetros vigentes**: mínimos de subordinação, periodicidade, regra por classe, concentração e decisão de incluir mezanino. Os percentuais do Excel não foram carregados como limites do motor.
5. **Memória do cálculo da administradora**: base bruta/líquida de PDD, classificação de cotas FIDC/outros valores, momento da fotografia e tratamento dos casos II/EDUC divergentes.

O informe contém `TAB_X_5` com faixas amplas de liquidez declarada à CVM e `TAB_VII_D` com recompra agregada. Esses valores não substituem as dez janelas de recebimento nem as categorias de baixas/recompras da planilha: em junho/julho, `TAB_X_5` é integralmente zero para II e NC apesar de posições e fluxos no relatório; a recompra CVM também diverge das categorias do relatório. Por isso não foram usados para preencher essas linhas como se fossem equivalentes.

Para outras gestoras, o código de cálculo lê uma configuração versionada de composição do DC e subordinação, em vez de CNPJs fixos. Nesta etapa, cada gestora deve operar em projeto Supabase isolado. Compartilhar a mesma instância com vários clientes exige antes `tenant_id`, políticas RLS por tenant e validação de isolamento em todas as tabelas, funções e Storage.

## Implementação e validação técnica

- A importação mensal do botão “Atualizar dados” alimenta `fund_monthly_cvm_filing`, por download CVM ou upload do ZIP original na interface; **ambos os caminhos preservam o ZIP exato em Storage privado, identificado por SHA-256**. Cada conjunto de tabelas recebe o hash, o caminho do arquivo e a origem. A competência dos fundos monitorados é substituída por completo numa transação serializada, impedindo mistura de tabelas antigas e novas numa reimportação. A nova função `calculate-liquidity-monthly` lê essa mesma tabela e grava no manifesto da execução a configuração da metodologia e a proveniência do ZIP; o motor FCC antigo continua a ler `fidc_informe_mensal_import` na sua trilha própria. A importação mensal exige usuário autorizado de Risco e registra `registry_sync_log` e `ingest_runs` (`running → ok/error`).
- A migration retira da tabela `fund_monthly_cvm_filing` a política antiga `portal_open_all` e a escrita por cliente: somente as funções com chave de serviço importam os fatos, e usuários ativos podem consultá-los. As tabelas novas também concedem apenas leitura autenticada. As demais tabelas legadas do portal ainda têm políticas amplas de `20260917180000_portal_open_access.sql`; a revisão de isolamento do projeto inteiro permanece pendente.
- A Carteira Diária CSV entra pela Edge Function `import-liquidity-position`, fica em Storage privado e produz resumo de posição versionado por hash. `liquidity_monthly_runs` guarda entradas, metodologia e resultado. Um hash novo gera nova execução, sem sobrescrever a anterior. A importação e o cálculo também registram suas execuções em `ingest_runs`.
- O portal `/liquidez/mensal` permite selecionar fundo, competência e metodologia ativa; calcula todos os fundos monitorados da competência em uma ação e exibe uma matriz consolidada com o último cálculo de cada fundo. O detalhe mostra valor, fonte e status de cada indicador, faixas agregadas da CVM, gaps e um mapa de cobertura por linha do relatório, incluindo os campos indisponíveis e a origem necessária. A planilha Excel não aparece no produto.
- `npm run build`: passou em 23/09/2026. `tsc --noEmit`: ainda falha em arquivos anteriores de outros módulos; nenhuma ocorrência foi reportada nos novos arquivos de tela. `deno check` das três Edge Functions novas/alteradas passou; o `jszip@3.10.1` usado pela importação foi declarado como dependência direta. O motor foi executado diretamente em Node 24 com os dois ZIPs originais. O CSV foi interpretado pelo parser TypeScript novo. Um ensaio de ausência de PL e TAB_V confirmou que PL, razões, subordinação, vencidos e faixas permanecem `indisponível`, sem conversão silenciosa para zero.
- As três migrations e Edge Functions foram aplicadas ao projeto `gwdtyorogmfijleoydvm` após autorização do usuário. A importação de junho (187.166 linhas CVM) e julho (189.528 linhas CVM) gravou 141 grupos de tabelas por competência, ambos com `ingest_runs.status=ok`. O envio da Carteira Diária NC e 16 cálculos persistidos (oito fundos × duas competências) foram concluídos pela interface em 24/09/2026. Treze indicadores de cada uma das 16 execuções foram confrontados com a prévia local gerada dos arquivos originais pelo mesmo parser e motor: **208/208 coincidiram sem diferença numérica**, incluindo despesas da NC. O relatório exibiu PL de julho do EDUC de R$ 123.357.518,32 na Base do portal, e os quatro gráficos renderizaram com esses dados. Isso valida o fluxo integrado desta amostra; não valida ainda capacidade para mais de 50 fundos nem o fechamento oficial de risco.

Em 24/09/2026, o ZIP original de julho foi reimportado pela nova interface. A resposta registrou 141 grupos e 8/8 cálculos automáticos; o relatório consultado em seguida mostrou os oito fundos disponíveis, PL do EDUC de R$ 123.357.518,32 e quatro gráficos alimentados pela Base do portal. A reimportação do mesmo arquivo não gerou divergência visível nos valores inspecionados. Falta conferir formalmente no banco hashes e logs da reimportação, testar o RBAC de Compliance com uma conta desse perfil e homologar os gaps de estoque/passivo antes de considerar o fechamento publicável. A conta do operador foi ativada como Risco para esta trilha, mantendo `user_profiles.access_type=consulta` para não liberar escrita geral no portal.

## Adaptação do artefato publicado pelo Claude (23/09/2026)

O artefato público [Relatório de Liquidez de FIDCs — Informe Mensal CVM](https://claude.ai/artifact/MDtPgVamrzBNAGTYapqeBt) foi aberto e suas abas **Relatório** e **Metodologia** foram verificadas. Sua ideia útil é preservar as linhas do relatório, com fonte/fórmula/status visíveis, e recalcular por competência a partir das Tabs do Informe, sem importar os números da planilha. A implementação local continua sendo Edge Function + Postgres + versão de metodologia; o HTML do artefato e seus dados embutidos não são dependências do portal.

Foi criada a metodologia `cvpar_fidc_mensal@2026.2`, preservando `2026.1` para comparações históricas. Ela acrescenta:

- **CPR residual:** `TAB_I4_VL_OUTRO_ATIVO + TAB_I3_VL_POSICAO_DERIV − TAB_III_VL_PASSIVO`. É posição contábil, distinta das despesas por natureza obtidas na Carteira Diária.
- **Aquisições e quantidade:** soma dos grupos com e sem aquisição substancial de risco da Tab VII. Em julho, o CVPAR I soma R$ 70.563.365,94; a planilha usa só R$ 43.434.357,24, omitindo R$ 27.129.008,70.
- **Sacados:** soma dos 1/5/10/15 maiores `VALOR` da Tab VIII dividida pelo PL, marcada como aproximada. O informe fornece até 25 valores e não um cadastro completo de títulos/devedores.
- **Cedente listado:** maior percentual declarado na Tab I, sem fingir que Top 5/10/15 está completo. Há até nove registros por grupo.
- **Vencidos por faixa e vencimentos:** Tabs V e VI, mantendo a primeira janela agregada em 0–30 dias; prazo médio estimado pelo ponto médio da faixa, com a janela aberta acima de 1.080 dias tratada pelo limite inferior de 1.080 dias.
- **DC líquido de PDD:** `DC bruto + PDD negativa`, inclusive o percentual sobre PL. A linha 31 do Excel de julho divide o DC bruto pelo PL; o portal identifica a correção em vez de repetir a fórmula errada.
- **Recompra CVM, taxa de cessão e subordinação mínima cadastrada:** disponibilizadas com ressalva de origem. O mínimo já estava no cadastro dos quatro fundos (5%, 15%, 40% e 10%); a folga é indicativa até confirmação de vigência do regulamento e regra por classe. O Middle Market não é cadastrado entre os quatro fundos monitorados.
- **Comparação mensal:** consulta execuções salvas da mesma versão de metodologia para o mês atual e anterior; ausência de cálculo não vira zero.

Conferência nova com o ZIP original de **julho/2026**, executando o parser e o motor TypeScript reais:

| Fundo | CPR residual CVM | CPR Excel | Aquisições CVM | Aquisições Excel | Maior sacado CVM / PL |
|---|---:|---:|---:|---:|---:|
| EDUC | -R$ 236.084,32 | -R$ 236.084,32 | R$ 8.916.056,34 | R$ 8.916.056,34 | 90,14% |
| I | -R$ 620.109,72 | -R$ 620.109,72 | R$ 70.563.365,94 | R$ 43.434.357,24 | 8,56% |
| II | -R$ 780.739,44 | -R$ 780.292,29 | R$ 62.470.218,08 | R$ 62.470.218,08 | 4,17% |
| NC | -R$ 62.807,01 | -R$ 62.807,01 | R$ 0,00 | R$ 0,00 | 100,08% |

O desvio de **R$ 447,15** do CVPAR II aparece tanto em DC Total (informe acima da planilha) quanto em CPR (informe abaixo da planilha), confirmando uma diferença de classificação entre as fontes, não uma diferença de PL. Para EDUC, o maior sacado do informe de julho é 90,14%; o Excel traz 92,41%, consistente com a defasagem de junho apontada no artefato. A Tab VIII não prova sozinho se a posição foi consolidada por CPF/CNPJ, por isso os Top N continuam aproximados. O artefato etiqueta algumas linhas como “bate” embora a própria metodologia reconheça divergências em CVPAR I; no portal, o status informa **qualidade da fonte/cálculo**, não promete concordância com a planilha.

O informe ainda não fornece estoque título a título, calendário de recebimentos, títulos liquidados, composição integral de cedentes nem passivo por cotista. As faixas de vencimento CVM e `liquidez imediata + DC até 30 dias` são apresentados como **posição/indicador contábil aproximado**, não como cobertura de resgates, projeção de caixa ou classificação final de risco.
