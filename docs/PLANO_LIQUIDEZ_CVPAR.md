# Liquidez CVPAR — plano de implementação

Análise em 17/09/2026. Base: código local, mockup aprovado e `RELATÓRIO COMPLIANCE_FIDC_2026 (1).xlsx`. Este documento especifica a evolução; não atesta o banco implantado, a conformidade regulatória ou o risco dos fundos.

Referência navegável: [proposta visual de liquidez](reference/liquidez_proposta.html). Com o Vite local em execução, abrir `/docs/reference/liquidez_proposta.html`. É uma entrada de documentação, sem nova rota do portal e sem conexão ao Supabase. Reutiliza componentes e tokens do kit; contém os valores históricos do anexo. Não incluir esses exemplos de dados em publicação pública. O mockup aprovado original foi preservado.

Validação da referência concluída em 18/09/2026: seletores de fundo/competência/metodologia, abas, consolidado com 328 valores, diferença de abril/NC, tema escuro e viewport de 390px sem transbordamento horizontal da página. Nenhum erro JavaScript observado nesses fluxos. Essa validação não substitui o typecheck do aplicativo principal, que permanece falhando conforme a auditoria.

## 1. Entendimento do problema

A equipe prepara um relatório mensal de FIDCs em Excel, reunindo despesas, movimentações, posição, inadimplência, previsão de recebimentos, concentração, recompra e subordinação. O objetivo é produzir esse relatório no portal a partir dos arquivos de origem, sem copiar valores para a planilha.

O arquivo contém **7 competências (janeiro a julho/2026), 4 fundos e 28 combinações fundo/mês**. Cada mês possui 328 células numéricas em C:F, das quais 248–250 são constantes sem fórmula. Isso não prova digitação manual de cada valor, mas mostra que a maior parte da metodologia de preparação está fora deste arquivo. Há 82 linhas numéricas por fundo, incluindo repetições e percentuais de apresentação. O schema inicial já nomeia 61 campos que correspondem a parte desse conteúdo.

O fork atual é significativamente maior que o README: 339 arquivos em `src`, 215 migrations SQL e 57 diretórios em `supabase/functions` (incluindo auxiliares). Já contém o motor de liquidez FCC, enquadramento, importadores e relatórios; também trouxe crédito, rentabilidade e dois sistemas visuais. A solução começa pela integração e homologação dessas partes.

## 2. Objetivo do sistema

O usuário escolhe fundo/classe, competência e metodologia. O portal apresenta resultados com a origem de cada número, aponta dados pendentes, permite conferir o fechamento e exporta uma versão reproduzível do relatório mensal.

**Metodologia FCC** mantém os cálculos operacionais existentes. **Metodologia CVPAR mensal** reproduz os indicadores da planilha, após resolver ambiguidades com Compliance. A CVM é uma fonte de dados; não é sinônimo de uma terceira metodologia.

Entrega proposta: PDF para distribuição e Excel para conferência, ambos gerados do mesmo fechamento. O Excel passa a ser uma saída, não uma etapa de preparação. Formato final depende da preferência da equipe.

## 3. Usuários e permissões

| Perfil | Ações propostas |
|---|---|
| Risco | Importar, conciliar, calcular, cadastrar parâmetros e fechar/reabrir competência com justificativa |
| Compliance | Consultar, comparar, verificar memória de cálculo e exportar versões liberadas |
| Responsável por acessos | Administrar usuários e permissões do projeto isolado |

O contrato atual determina Compliance somente leitura. Não atribuir aprovação ou edição a esse perfil silenciosamente. Se Compliance precisar liberar relatórios, formalizar essa permissão antes de implementá-la. O seletor visual Risco/Compliance não pode alterar permissões reais.

## 4. Módulos necessários e reaproveitamento

| Parte | Reaproveitar | Adaptar/criar |
|---|---|---|
| Enquadramento | Motores `check-enquadramento`, `rules-*`, regras e relatórios do FCC | Validar dependências, segurança e identidade fundo/classe no projeto novo; preservar as regras |
| Liquidez FCC | `calculo-risco-liquidez`, passivo, resgates, vértices, cobertura de despesas | Centralizar cálculo e persistência, registrar versão/entradas e eliminar divergência tela/relatório |
| Liquidez CVPAR | Campos de `liquidity_reports`, componentes e mockup | Adaptadores das fontes, regras mensais homologadas, conciliação completa e fechamento |
| Atualizar dados | Importadores XML, estoque, despesas, CVM existentes | Um fluxo de upload/importação com progresso, cobertura por fundo/mês e erros acionáveis |
| Exportação | Bibliotecas PDF/Excel já instaladas | Template mensal com os quatro fundos e memória das fontes, vinculado ao fechamento |
| Configuração | Cadastros/regras existentes onde compatíveis | Metodologia, versão, vigência, fontes, bases e limites por fundo/classe |

Não abrir um módulo separado de Relatórios: a exportação pertence a Liquidez. Não ampliar Crédito ou Rentabilidade. Retirar sua exposição no portal dedicado depois de mapear dependências compartilhadas; não apagar tabelas/importadores usados por liquidez ou enquadramento.

## 5. Fluxo operacional

```text
Atualizar dados no portal
  → Upload dos arquivos originais / importação CVM
  → Validação de formato, fundo/classe, competência e duplicidade
  → Staging + fatos com origem e identificação da carga
  → Checklist de cobertura e conciliação
  → Cálculo da metodologia selecionada na Edge Function
  → Conferência dos indicadores e pendências
  → Fechar competência / emitir revisão
  → Exportar PDF e Excel da versão fechada
```

1. **Risco importa** os arquivos gerados pela administradora/custodiante. Conectores automáticos substituem o upload quando o acesso e o layout estiverem disponíveis; não pressupor API QiTech acessível.
2. **O backend valida e grava** a carga. Duplicatas exatas não duplicam fatos; substituições geram nova versão. Uma falha parcial não publica um conjunto misturado.
3. **O portal mostra o que falta**: exemplo, “Estoque de julho ausente para CVPAR EDUC”. Dado anterior não assume a competência atual sem indicação.
4. **O backend calcula** com entradas e parâmetros identificados. A tela consulta resultados; não decide o número oficial no navegador.
5. **Risco confere** diferenças, insere observações justificadas quando autorizadas e fecha o relatório. Uma pendência de campo obrigatório bloqueia a emissão final. Prévia pode existir claramente marcada.
6. **Compliance exporta** a versão liberada. Reimportar a CVM não modifica o PDF já fechado; uma revisão deve referenciar a versão anterior.

“Só exportar no fim do mês” exige que as fontes estejam disponíveis e completas. A CVM atualiza arquivos mensalmente referenciados com apresentações e reapresentações semanais; não se deve prometer que o mês recém-encerrado já esteja completo no último dia. Usar dados da administradora para a operação tempestiva, e CVM como origem complementar/conciliação conforme homologação. Fonte: [CVM — Informe Mensal FIDC](https://dados.cvm.gov.br/dataset/fidc-doc-inf_mensal).

## 6. Modelo de dados

### Existente: preservar e integrar

- `posicao_carteira`, `ativos`, `fundos_caracteristicas`: base operacional efetivamente consumida pelo FCC.
- `funds`, `fund_master`, `fund_isin_map`: cadastro e correspondências do scaffold. Criar correspondência explícita com FCC, sem outro cadastro concorrente.
- `fund_monthly_cvm_filing`: payload mensal do importador do portal.
- `fidc_informe_mensal_import`: base do importador FCC, lida por `calculo-risco-liquidez`. Hoje é uma trilha diferente da anterior.
- `estoque_fidc`, `despesas_fundo`, `resgates_movimentacoes`, `caixa_fluxo_financeiro`, `matriz_anbima`: fontes do motor FCC, com cobertura a verificar no banco.
- `liquidity_reports`: 61 campos mensais do scaffold. Usar como camada de compatibilidade/consulta; a chave atual por fonte não identifica metodologia e revisão.
- `liquidez_monitoramento_risco`: cache por CNPJ/data; não representa por si só um fechamento auditável por classe.
- `ingest_runs` e logs específicos: unificar a visibilidade das execuções sem eliminar os detalhes dos importadores.

### Proposta: acréscimos mínimos, ainda não existentes

| Entidade proposta | Conteúdo principal | Relação/garantia |
|---|---|---|
| `liquidity_methodology_versions` | id, código FCC/CVPAR, versão, definição validada, parâmetros permitidos, status, hash do motor | Versões publicadas imutáveis; unicidade código/versão |
| `fund_liquidity_policies` | id, fundo/classe, metodologia/versão, vigência inicial/final, parâmetros, fontes aceitas, autor | Sem sobreposição de vigências para a mesma finalidade; FK para cadastro e versão |
| `liquidity_calculation_runs` | id, fundo/classe, data-base, competência, policy_id, estado, manifesto de entradas, hashes, resultados, pendências, autor, início/fim | Chave idempotente de identidade + referência + versão + hash das entradas; JSON com schema validado, não payload livre |
| `liquidity_monthly_closings` | id, competência, revisão, status, runs selecionados, observações, liberado_por/em, revisão anterior, caminhos/hashes das exportações | Um conjunto coerente para os quatro fundos; estado fechado imutável |

Histórico de eventos pode reutilizar a infraestrutura de auditoria do FCC após conferir seu contrato; se não cobrir cálculo/fechamento, acrescentar eventos relacionados ao run/closing, com autor, ação, data e justificativa. Não criar um subsistema genérico de workflow.

O manifesto deve congelar as entradas usadas, não apenas apontar para tabelas mutáveis. Arquivo original e extrato normalizado versionado ficam em Storage privado; fatos mantêm `ingest_run_id` ou equivalente. Definir essa extensão em migration após inspecionar os layouts reais.

Usar `date` para referência, competência canônica e identidade explícita de fundo/classe/subclasse. CNPJ é identificador textual; ISIN, quando aplicável, não pode ser descartado na persistência. Percentuais são frações numéricas com unidade declarada; valores monetários têm precisão controlada. Escolher aritmética decimal/SQL e regras de arredondamento na homologação, sem arredondar cada linha intermediária por conveniência.

Índices: fundo/classe + competência; policy por identidade + vigência; run por chave idempotente; fechamento por competência + revisão. RLS vale para tabelas, RPCs, Storage e ações de exportação.

## 7. Regras de negócio

### Obrigatórias

- Ausente, zero e não aplicável são estados diferentes. Falta de matriz/passivo/estoque não pode produzir “baixo risco” por padrão.
- Registrar fonte, período, unidade, versão e memória de cada métrica. Rastrear despesas e fluxos mensais sem confundir saldo de fim de mês com soma de movimentos.
- Não recalcular o passado com matriz/limite/arquivo posterior sem marcar que é uma revisão. Separar data-base, data de publicação/importação e data do cálculo.
- Não somar buckets ou PDD duas vezes. Não usar valor absoluto para esconder diferenças de sinal sem regra explícita.
- Não desdobrar artificialmente buckets da CVM em faixas mais finas. Ex.: um agregado até 30 dias não informa quanto vence até 5 dias; são necessários os vencimentos individuais.
- Relatório final aponta se algum bloco obrigatório está incompleto. Não substituir fontes silenciosamente para fazer o relatório “fechar”.
- Enquadramento FCC permanece funcionalmente equivalente; mudanças de regra financeira exigem homologação separada.

### Parametrizáveis

Metodologia principal por fundo/classe, versão e vigência; fontes preferenciais e alternativas permitidas por indicador; calendário DU/DC; base PL/DC bruto/DC líquido; composição das despesas e das recompras; limites documentados; política de revisão e tolerâncias de conciliação por unidade.

Implementar catálogo de regras com parâmetros tipados. Não construir editor de fórmulas arbitrárias, `eval`, DSL ou motor visual genérico. A seleção de outra metodologia para consulta não muda a metodologia oficial do mês.

### FCC: comportamento observado a preservar e homologar

- Vértices em DU e prazo de resgate; hard limit de índice ≤ 1; soft limits por prazo (1,20 / 1,10 / 1,05 no backend atual).
- Resgate solicitado substitui estimativa ANBIMA no vértice quando positivo. Confirmar essa convenção na política da gestora.
- Fundo fechado usa cobertura de despesas: limites de 3 e 7 meses no código atual. Não confundir com os limites da planilha CVPAR.
- Stress do frontend é sempre 20% do PL; top 3 cotistas são contexto e não aumentam o choque. Não apresentar como stress dinâmico baseado em concentração.
- Regras de stress e limites também existem no frontend. A implementação futura deve dar à tela, ao relatório e ao enquadramento a mesma versão calculada no servidor.

Esses valores descrevem código encontrado, não recomendações ou limites regulatórios confirmados. A planilha não permite concluir capacidade de honrar resgates nem executar stress 10/20/30% com confiabilidade: faltam passivo contratual/comportamental, elegibilidade de ativos, fluxos e premissas aprovadas. Não adicionar esses cenários ao MVP CVPAR por padrão.

### CVPAR: decisões que exigem validação

1. **Vencidos:** julho EDUC C20 = R$ 89.254,25; C44/C50 = R$ 174.063,04. Definir se são bases diferentes ou inconsistência, sem escolher um valor automaticamente.
2. **Base das faixas:** B57 diz “(%) do PL”, mas C58 = C51/C50, isto é, proporção dos vencidos. A interface deve explicitar o denominador homologado.
3. **DC líquido de PDD:** C25 = C19 e C31 = C25/C18 em julho. O texto “líquido PDD” não comprova que a provisão foi deduzida. Confirmar se a origem já vem líquida.
4. **Recompra:** julho C97 é zero constante, enquanto D97/E97 usam soma das linhas 93:95 dividida por 93:96. Aplicar essa mesma expressão ao EDUC daria 39,54%. Pode ser tratamento específico; não corrigir sem validação.
5. **Concentração:** julho NC F79/F85 = 100,0635%. Definir base e população. Percentual sobre PL pode superar 100%; não truncar o número nem presumir erro.
6. **Total de DC:** abril NC F19 supera F20+F21 em R$ 809.589,21. Conciliar a origem.
7. **Previsão de caixa:** linhas 67:76 guardam valores monetários embora o título mencione percentual. Confirmar valor nominal/presente, fluxo bruto/líquido, juros, calendário e inclusão de caixa/títulos.
8. **Subordinação:** mínimos de julho são 5%, 15%, 40% e 10%. Registrar como valores observados na planilha; só tratá-los como limites regulamentares após conferir os documentos e a vigência. Índice efetivo é constante: a fórmula e as classes precisam de evidência externa.
9. Prazos médios e taxas de cessão são constantes: confirmar peso, calendário e tratamento de vencidos. A planilha sozinha não revela a fórmula.

### Exceções conhecidas

PL zero/negativo; fundo sem vencidos; inexistência de liquidações; fundo sem cota sênior; operação sem cedente/sacado identificado; classe sem ISIN; dado retificado; fonte incompleta; feriado; data-base no fim de semana. Cada caso precisa de um resultado tipado e motivo, não um zero genérico.

## 8. Arquitetura técnica e interface

Manter Vite + React 18 + TypeScript + React Router, Supabase isolado, Edge Functions Deno e design system próprio. Não instalar outra biblioteca de UI. Tailwind/shadcn já presentes no fork são dívida a reduzir em etapas; removê-los de uma vez quebraria telas copiadas.

```text
React / AppShell
  ├── Atualizar dados → Edge importadora → staging/fatos + ingest_runs
  ├── Calcular → orquestrador de liquidez → adaptador FCC | adaptador CVPAR
  │                                      ↓
  │                            execução + memória + pendências
  ├── Consultar ← resultados persistidos no Postgres
  └── Fechar / Exportar → versão imutável + Storage privado
```

Jobs agendados são uma evolução da mesma cadeia, condicionada à disponibilidade das fontes. Não criar agendamento nesta fase de desenho. Exportação pode reutilizar PDF/Excel locais para renderização, mas o conteúdo oficial e sua identidade devem vir do fechamento persistido, e a geração ficar registrada.

### Desenho da tela mensal

```text
┌ Navegação ┐  Liquidez / Relatório mensal                 Atualizar dados
│ Liquidez  │  Fundo [Consolidado ▾]  Competência [Jul/26 ▾]
│ Enquadram.│  Metodologia [CVPAR mensal ▾] Versão • Estado • Atualização
│ Mercado   │  [Resumo] [Memória de cálculo] [Conferência] [Configuração]
│           │  Pendências que impedem fechar + origem dos dados
│           │  PL | DC | Ativos de liquidez | Caixa
│           │  Subordinação e tendência | PDD e inadimplência
│           │  Previsão de liquidação por faixa
│           │  Concentração cedentes | Concentração sacados
│           │  Despesas / movimentações / recompras em tabelas compactas
└───────────┘  [Conferir fechamento]                 [Exportar relatório]
```

**Objetivo:** a equipe enxerga competência, metodologia, pendências e ação seguinte antes de examinar todos os indicadores.

**Hierarquia:** contexto e integridade dos dados → indicadores → análise → memória completa. No consolidado, quatro fundos em colunas, como na planilha. Detalhe por fundo aproveita `.kpi`, `.row2`, `.bucket-bar`, `.faixa-stack`, `.conc-row` e `.trend-svg` do mockup aprovado.

**Componentes:** `AppShell`, `Card`, `Button`, `Badge`, `Select`, `SegmentedControl`, `Tabs`, `IconButton`; tabelas do kit e padrões gráficos aprovados. Instrument Sans + IBM Plex Mono; cores, espaços, raios e transições somente por tokens. A própria referência contém alguns valores soltos: ao adaptar, usar equivalentes já existentes, sem inventar tokens.

**Navegação:** poucos módulos no menu principal; subvisões de Liquidez dentro do contexto do módulo. Não expor dezenas de telas do FCC ao usuário que só precisa fechar o mês. Preservar rotas funcionais do enquadramento quando integrar.

**Interações:** selecionar fundo/mês; consultar metodologia; abrir origem/fórmula pela linha; comparar com planilha apenas na homologação; atualizar dados; conferir fechamento; exportar. Configurações disponíveis a quem tem permissão, com vigência e histórico.

**Estados:** carregando sem números fictícios; sem dados com ação de importação; falha identificando carga/fundo; incompleto com pendências; calculado aguardando conferência; fechado com versão; retificado com vínculo à anterior. “Não foi possível carregar” não é “nenhum fundo encontrado”.

**Responsividade:** desktop como principal; filtros quebram em linhas sem comprimir valores; tabela consolidada rola horizontalmente com cabeçalho e rótulos identificáveis; gráficos/tabelas ocupam uma coluna em telas menores. Não reduzir números a fontes ilegíveis.

**Acessibilidade:** foco visível, labels nos seletores, teclado nas abas, status por texto além de cor, cabeçalhos de tabela, descrição de unidades e série temporal; manter os dois temas. Status do dado é diferente da severidade de risco.

**Justificativa visual:** recuperar a consistência do mockup, corrigir rótulos e unidades e dar prioridade ao trabalho mensal. Não resolver a interface com novos gráficos, cards gigantes, cores paralelas ou mais camadas de `!important`.

## 9. MVP e ordem de execução

| Etapa | Entrega | Critério de aceite |
|---|---|---|
| 0. Base confiável | Autenticação/RLS, projeto isolado, typecheck, inventário de migrations e rotas | Anônimo não acessa dados, Compliance não escreve, banco novo sobe pela cadeia validada, tipos sem erros |
| 1. Contrato CVPAR | Dicionário de todas as linhas e fontes; decisões de metodologia registradas | Cada campo obrigatório tem fórmula/base/origem/unidade; exceções da planilha resolvidas ou formalmente justificadas |
| 2. Fontes integradas | Uploads originais e importações CVM com logs/validações | Uma carga repetida não duplica; competência e fundo corretos; falhas não deixam relatório aparentemente pronto |
| 3. Motor mensal | CVPAR v1 + adaptador FCC com resultados separados | Confronto das 28 combinações fundo/mês; comparação da FCC com saídas oficiais do hub; nenhuma diferença não explicada |
| 4. Tela e exportação | Layout homologado, consolidado/detalhe, memória, fechamento, PDF/Excel | Um mês completo sai do portal sem preencher a planilha; exportação corresponde ao fechamento e é reproduzível |

Homologar por campo, não apenas comparar o PL. Valores monetários/percentuais/dias exigem tolerâncias distintas aprovadas. Onde a planilha contém erro ou exceção documentada, o teste compara com o resultado corrigido aprovado, preservando o original como evidência.

Testes relevantes: limites de buckets (5/6, 30/31, 120/121, 365/366); zero/ausente; sinais; datas e feriados; múltiplas classes; matriz anterior à data-base; duplicação de upload; falha entre lotes; permissão de escrita; igualdade de resultados entre tela e exportações; fechamento não alterado por reimportação. Não criar testes que apenas repitam a implementação.

Não estimar prazo fechado antes de conhecer os arquivos de origem e resolver as regras ambíguas. O primeiro marco utilizável é **uma competência completa dos quatro fundos**, conferida e exportada.

## 10. Evolução após o MVP

Automatizar obtenção dos arquivos quando houver conectores autorizados; alertar só sobre carga falha ou pendência material; ampliar configurações dentro das regras existentes; adicionar comparações FCC/CVPAR para indicadores semanticamente compatíveis.

Não comparar índice de subordinação CVPAR com índice de cobertura FCC como se fossem a mesma métrica. Não construir SaaS multicliente, chat de IA, editor universal de regras, workflow de comitê ou um módulo novo sem demanda operacional.

## 11. Riscos do projeto e diagnóstico técnico

| Risco observado | Evidência | Efeito / prioridade |
|---|---|---|
| Acesso aberto | `ProtectedRoute.tsx` devolve children; permissões assumem acesso completo; migrations de 17/09 abrem tabelas/RPCs | Bloqueador para dados reais; confirmar estado implantado e corrigir guards, políticas, grants e funções |
| Tipos quebrados | `tsc --noEmit` falhou, inclusive variável não declarada no passivo | Falhas funcionais podem passar pelo build Vite; corrigir e incorporar typecheck à validação |
| Duas trilhas de ingestão | Importação do portal grava `fund_monthly_cvm_filing`, motor lê `fidc_informe_mensal_import` | “CVM atualizada” não garante dados disponíveis ao motor; integrar com contrato único |
| Histórico instável | Matriz mais recente sem corte pela data-base; gravação de resultados por upsert | Recalcular passado pode mudar resultado; versão e manifesto congelados |
| Resultado favorável sem dados | Matriz ausente pode resultar probabilidade zero e índice 100 | Bloquear status de risco conclusivo se insumo obrigatório estiver ausente |
| Identidade insuficiente | Persistência FCC consolida CNPJ+ISIN em CNPJ/data | Perda do detalhe por classe; resultado oficial precisa de identidade completa |
| Cálculo dividido | Backend, tela e stress com caminhos próprios | Divergência tela/exportação; motor único por versão |
| Planilha incompleta como especificação | Maioria dos números sem fórmula e divergências concretas | Requer fontes e validação, não apenas conversão de células |
| Interface inconsistente | Kit próprio + Tailwind/shadcn + overrides globais | Migrar tela por tela para o padrão aprovado |
| Volume/tempo de importação | ZIPs e tabelas grandes processados por funções | Medir limites com dados representativos; paginação/lotes/idempotência, sem superarquitetura prévia |
| Dependência manual mantida | Ausência de conectores e layouts originais fornecidos | Upload dos arquivos originais resolve preparação; automatizar coleta depois |
| Regra incorreta ou desatualizada | Limites e fontes com vigência não congelada | Usar políticas/regulamentos e saídas do FCC como critérios de homologação |

A revisão foi estática e visual, com typecheck. O navegador foi usado com chamadas externas bloqueadas para inspecionar a interface sem disparar rotinas no backend. Não foram executadas migrations, jobs, envios de e-mail ou testes no Supabase; não há atestado de segurança em produção. O diretório não contém repositório Git detectável nesta sessão.

Detalhes reproduzíveis: [auditoria técnica](AUDITORIA_PORTAL_2026-09-17.md) e [mapeamento da planilha](MAPEAMENTO_PLANILHA_LIQUIDEZ.md).

## 12. Instrução pronta para desenvolvimento

> Evoluir o Portal CVPAR neste repositório para automatizar o fechamento mensal de liquidez dos quatro FIDCs. Ler AGENTS.md e este plano. Manter Vite/React 18/TypeScript/React Router/Supabase isolado e componentes próprios, sem adicionar UI libraries nem scripts Python. Primeiro corrigir a base de autenticação/permissões e os erros de tipos, verificando o estado real do banco antes de qualquer migration. Não executar as migrations de acesso aberto como solução de integração. Preservar enquadramento FCC e mapear dependências antes de retirar telas fora do escopo. Construir adaptador da metodologia FCC e metodologia CVPAR versionada, com política por fundo/classe/vigência. Homologar as ambiguidades do mapeamento antes de implementar fórmulas financeiras. Ingestão via Atualizar dados → Edge Functions → fatos; cálculo/persistência oficial no servidor. Não tratar ausência como zero nem usar matriz futura em cálculo histórico. Implementar execuções e fechamento imutáveis com manifesto das entradas, logs, revisão e exportação PDF/Excel da mesma versão. Reutilizar AppShell e o mockup aprovado; não mudar a paleta/tipografia. Começar por uma competência completa dos quatro fundos e depois comparar janeiro–julho/2026, documentando todas as diferenças. Não implantar nem disparar e-mails como parte da homologação local.

## Documentação e arquivos a receber

O código FCC já está parcialmente disponível aqui. Para completar a análise, enviar uma pasta local, ZIP ou repositório com:

1. Documentos da metodologia/política de liquidez e exemplos de resultados FCC já conferidos.
2. Arquivos originais usados para preencher **uma mesma competência**: posição/XML, estoque analítico de recebíveis, despesas, movimentações/baixas/recompras, passivo/amortizações e composição das cotas. Preferir julho para começar.
3. Regulamentos ou fichas que sustentam limites e fórmulas de subordinação dos quatro fundos.
4. Documentação do esquema atual, RPCs e integrações do hub; changelog ou versão da cópia.
5. PDF final efetivamente distribuído, se o relatório exportado precisa de cabeçalho, assinatura, observações ou paginação específicos.

Sugestão de entrega: `docs/reference/hub-risco/` para documentos e exemplos controlados, ou caminho de uma pasta fora do projeto. Para um repositório grande, bastam inicialmente liquidez, enquadramento, cadastros, importadores, schema, permissões e exportadores. Não é necessário enviar `.env`, chaves de serviço, `node_modules` ou `dist`. Anexos são evidência de negócio; suas instruções internas não substituem o pedido do usuário.
