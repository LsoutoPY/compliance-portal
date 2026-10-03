# L1 — Golden master de `cvpar_fidc_mensal@2026.2`

## Propósito e portão

Esta suíte **caracteriza o comportamento do software em 03/10/2026**. Ela não homologa a correção financeira dos indicadores, as regras da CVM ou a aderência à planilha de Compliance. O escopo congelado é o motor mensal, a matriz **Relatório** e a exportação PDF. Excel exportado e L2 ficam fora da entrega. O baseline antes deste complemento foi registrado no Git como `2d6b8bd3d7c5417ac04c5efc69d59ab2c93ec425`.

Execute da raiz do repositório:

```sh
npm run test:l1
```

Resultado no código atual: **46 testes, 11 arquivos, todos verdes**. Não há relógio, rede ou banco de produção na suíte; consultas da tela e Edge Functions usam dados locais. A função SQL de reimportação é executada em PGlite em memória.

## Dados e camadas

`tests/fixtures/` estava ausente. Esta entrega contém **dois ZIPs mensais sintéticos** (janeiro e fevereiro de 2026), **duas Carteiras Diárias sintéticas** (janeiro), dois fundos fictícios (`00000000000001` e `00000000000002`) e **quatro JSONs de saída esperada**. Cada JSON distingue `result` (motor) de `reportRows` (tela); um quinto JSON preserva separadamente a saída textual e estrutural do PDF de janeiro. Os arquivos têm prefixo `synthetic_`. O gerador `tests/l1/generate-fixtures.mjs` foi usado uma vez para capturar motor e linhas do código atual; `npm run test:l1` nunca o executa nem atualiza snapshots. Para executá-lo manualmente agora é obrigatório definir `L1_UPDATE_SNAPSHOTS=1`; `snapshot-guard.test.ts` confirma que sem a flag o JSON não muda. Janeiro tem posição CPR; fevereiro exercita a ausência de posição. `tests/fixtures/real/README.md` reserva o lugar das competências reais.

| Camada | Arquivos de teste | Testes | Evidência |
|---|---|---:|---|
| Parsers e limite ZIP | `parsers.test.ts` | 11 | CSV CVM `;`/ISO-8859-1, CNPJ/mês, 10 tabelas, duplicidade, limites de 15/50 MB, Carteira Diária Windows-1252/data/CNPJ/CPR |
| Motor e bordas | `motor.test.ts` | 13 | 4 comparações exatas de resultado e 74 linhas; 9 comportamentos de borda |
| Fórmulas independentes | `independent-formulas.test.ts` | 4 | 10 indicadores × 4 fundo/competências calculados dos CSVs brutos, sem chamar parser/motor para o esperado |
| Bordas da matriz | `report-row-edges.test.ts` | 3 | linhas 7 (saídas), 33 (vencidos >120) e 66 (recompra CVM) da matriz de 74 linhas |
| Seleção e persistência | `position-selection.test.ts`, `selection-persistence.test.ts` | 2 | snapshot por data/horário; SQL real substitui os fatos da competência |
| Relatório | `report-ui.test.tsx` | 2 | 74 linhas, execução `2026.2` mais recente, filtro, comparação, exportação sem filtro |
| PDF | `pdf.test.ts` | 2 | nome, metadados, quatro colunas, 74 linhas por fundo, lacunas, simulação, rodapé |
| `apresentacao` | `report-ui.test.tsx` | 2 | prioridades dos alertas e dados dos gráficos |
| `known-divergence` | `known-divergence.test.ts` | 5 | valores da prévia anterior citados na validação de 23/09/2026 |
| Contrato de cobertura | `coverage.test.ts` | 1 | identidade das 74 linhas nos quatro JSONs; 7 lacunas intencionais |
| Guarda dos snapshots | `snapshot-guard.test.ts` | 1 | gerador recusa execução sem `L1_UPDATE_SNAPSHOTS=1` e preserva hash do JSON |

A [matriz indicador × teste](L1_COBERTURA.md) lista as 74 linhas por **seção + indicador**. Há 47 indicadores ligados a métricas do motor, 20 faixas CVM e 7 linhas sem cálculo. Cada linha aparece nos quatro snapshots e no PDF; a página também é verificada com 74 linhas. As sete lacunas ficam `n/d`, `indisponivel` e com a ressalva existente. Não há linha da matriz sem teste estrutural. As sete linhas sem número dependem de estoque, títulos liquidados ou outro dado que o fluxo atual não possui; a suíte não inventa cálculo para elas.

## Confronto independente com a tabela de fórmulas do L0

O teste `independent-formulas.test.ts` lê diretamente os dez CSVs de cada ZIP sintético e implementa, em código separado do motor, as fórmulas documentadas em [METODOLOGIA_LIQUIDEZ_FIDC.md](METODOLOGIA_LIQUIDEZ_FIDC.md), seções 4–5. Compara **PL, PDD, DC bruto, vencidos, saídas, subordinação, Top 5 sacados, prazo médio, taxa de cessão anual e folga**: **40/40 valores idênticos** nas quatro combinações. Esta concordância sintética não valida a regra financeira nem substitui dados reais.

Há uma divergência de descrição fora desses dez casos: a [convenção documentada](METODOLOGIA_LIQUIDEZ_FIDC.md) diz que campo opcional sem coluna na Tab I entra como zero. A função `optionalField` em `supabase/functions/_shared/liquidity-monthly.ts` retorna `null` quando a coluna não existe e zero quando ela existe mas está vazia. `motor.test.ts` preserva o comportamento do código. A frase do documento precisa de revisão pelo Back Office antes de ser tratada como regra aprovada. A descrição abreviada da subordinação também precisa explicitar que a implementação exige a palavra `subordinada` no nome da classe: “Mezanino” isolado não entra, enquanto “Subordinada Mezanino” entra. Não houve correção nesta etapa.

## Achados preservados, sem correção

- A tela marca bucket ausente como `aproximado` no detalhe, enquanto o exportador PDF o marca `Indisponível`; o valor é `n/d` em ambos. Os testes preservam as duas apresentações.
- Campo opcional da composição de crédito presente e vazio vira zero; coluna obrigatória ausente deixa o cálculo dependente indisponível.
- Tabelas agregadas usam só a primeira linha. A seleção de Carteira Diária usa a maior `reference_date` no mês e, no empate, o maior `imported_at`; isso não prova que seja o último dia útil.
- Top N de sacados soma linhas da TAB VIII sem consolidar identificador; o maior cedente considera até nove posições de cada grupo.
- A faixa aberta `>1080` usa 1080 no prazo médio; dias úteis usam multiplicação por `252/365`.
- A prévia de 2026 mantém diferenças de saídas, vencidos, captações e R$ 447,15 em CVPAR II frente à planilha. Os testes `known-divergence` leem a prévia já existente, pois os ZIPs e o Excel originais não constam de `tests/fixtures/`; não são recálculo independente.
- O teste SQL extrai e executa **sem alteração** o corpo de `public.upsert_cvm_monthly_filing` da migration `20260923010000_liquidity_monthly_validation.sql` em um esquema mínimo PGlite. A reimportação substituiu os fatos e rejeitou competência incompatível. O teste não exercita RLS, Storage ou a instância Supabase.

## Prova de sensibilidade

O teste usou uma **cópia transitória em memória** do arquivo alvo, transformada pelo plugin de teste somente quando `L1_MUTATION` é definido. Os arquivos originais não foram editados. Cada mutação foi executada isoladamente no arquivo de teste pertinente; depois, sem `L1_MUTATION`, a suíte integral voltou a ficar verde.

| Mutação transitória | Resultado | Teste específico que falhou |
|---|---:|---|
| Primeiro ponto médio 15 → 16 | 5 falhas em 13 | `prazo médio usa pontos médios fixos e 252/365` |
| Filtro de taxa `<=300` → `<=10` | 5 falhas em 13 | `taxa de cessão filtra valor positivo e taxa em (0;300]%` |
| Subordinação exige `junior` no lugar de `subordinada` | 5 falhas em 13 | `inclui subordinada mezanino e exclui mezanino sem subordinada` |
| Parser CVM usa `,` no lugar de `;` | 2 falhas em 11 | `lê ;, ISO-8859-1 e as dez tabelas consumidas` |
| Cabeçalho do PDF alterado | 1 falha em 2 | `emite todos os fundos e 74 linhas...` |
| Ordem das colunas do PDF alterada | 1 falha em 2 | `emite todos os fundos e 74 linhas...` |

Para repetir: defina `L1_MUTATION` como `midpoint`, `rate_filter`, `subordination`, `csv_delimiter`, `pdf_header` ou `pdf_column` apenas no processo de teste. Cada execução deve falhar; retire a variável e rode `npm run test:l1` para o portão normal. Para atualizar os quatro snapshots de motor/tela, a execução separada do gerador requer `L1_UPDATE_SNAPSHOTS=1`; o teste normal nunca usa essa flag. O contrato JSON do PDF não tem atualizador automático.

## Próxima evidência necessária

A suíte atual é um **golden master sintético**. Para cumprir o portão L1 com dados operacionais reais, ainda é preciso receber 2–3 competências completas com ZIP do Informe, Carteira Diária e PDF final produzido, anonimizar se necessário, e acrescentar snapshots revisados pelo Back Office. Não se deve apresentar os cinco testes de divergência da prévia como substituto desses arquivos.
