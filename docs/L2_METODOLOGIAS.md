# L2 — Casca de metodologias de liquidez

## Estado da entrega

Esta etapa encapsula `cvpar_fidc_mensal@2026.2` sem alterar `calculateMonthlyFidc`, as 74 linhas da aba Relatório ou o exportador PDF. A L1 continua sendo uma caracterização **sintética** do software, não uma homologação financeira. L3, `fechado_caixa`, `aberto_anbima` e `PipelineAdapter` não fazem parte desta mudança.

O contrato em `supabase/functions/_shared/liquidity-methodology.ts` declara identificação, versão, aplicabilidade, contratos de entrada, validação, cálculo puro, memória e saída comum. A saída comum não substitui o JSON mensal persistido. Para esta versão, o indicador principal é a razão contábil `immediatePlusDue30ToPl`, com horizonte contratual de 30 dias. **Índice de cobertura do passivo é `null`**: o método não conhece resgates e obrigações futuras, portanto não infere cobertura.

`ManualUploadAdapter` transforma os fatos já importados em entradas do motor. A ordem recebida das tabelas, a substituição de tabelas repetidas pelo último payload e a ausência de posição foram preservadas. O ZIP mensal guarda origem, SHA-256, horário, Storage e ID de `registry_sync_log`; o log novo guarda `initiated_by`. A posição guarda arquivo, hash, horário e `imported_by`. Registros legados podem ter usuário desconhecido. Um download CVM iniciado pelo operador pertence ao adaptador atual, assim como o upload. O adaptador não lê banco nem rede.

## Vigência e histórico

`20261003010000_liquidity_methodology_assignments.sql` cria atribuição por fundo e período, rejeita vigências sobrepostas e impede alteração ou exclusão de versões publicadas. A migration atribui `2026.2` apenas a CVPAR EDUC, CVPAR I, CVPAR II e CVPAR NC a partir de janeiro de 2026. Outros fundos precisam de decisão explícita. Execuções antigas permanecem como foram gravadas, com código e versão próprios.

`methodologyStatusForFund` marca fundo sem atribuição como `pendente_metodologia`, sem execução da versão vigente como `pendente_calculo` e execução existente como `aguardando_revisao`. O status nunca transforma um número calculado em aprovação. A trilha de revisão/aprovação e a tela da matriz ainda precisam ser ligadas antes do portão L2.

As migrations desta etapa estão apenas no repositório. Aplicá-las ao Supabase e publicar Edge Functions exige implantação separada e validação do ambiente de destino. A tela mensal atual continua consultando suas execuções como antes.

## Verificação

- `npm run test:l1`: 46 testes verdes. Compara números, relatório e PDF com as saídas salvas.
- `npm run test:l2`: inclui L1 e testes do contrato, adaptador, vigência em PGlite e status; 57 testes verdes nesta revisão.
- `npm run build`: passou antes da migration/adaptador; repetir no fechamento da L2.
- `npx tsc --noEmit`: falha em erros preexistentes de outras áreas; nenhum erro aponta para arquivos novos desta etapa.

## Mapeamento de entrada para contratos

O contrato `informe_mensal_cvm` recebe as linhas originais das Tabs I, III, IV, V, VI, VII, VIII, IX, X.2 e X.4. O dicionário campo a campo e as fórmulas implementadas estão em [METODOLOGIA_LIQUIDEZ_FIDC.md](METODOLOGIA_LIQUIDEZ_FIDC.md), seções 4 e 5. `carteira_diaria` entrega o resumo CPR da posição selecionada; `minimo_subordinacao` vem de `funds`, não do informe. Estoque título a título, passivo de cotistas e fluxo de caixa projetado **não têm correspondência** no Informe Mensal CVM e permanecem lacunas. Antes do `PipelineAdapter`, será necessário documentar o mapeamento completo da origem normalizada para cada um desses contratos.
