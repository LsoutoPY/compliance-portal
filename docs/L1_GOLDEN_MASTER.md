# L1 — Golden master de `cvpar_fidc_mensal@2026.2`

## Propósito e portão

Esta suíte **caracteriza o comportamento do software em 02/10/2026**. Ela não homologa a correção financeira dos indicadores, as regras da CVM ou a aderência à planilha de Compliance. O escopo congelado é o motor mensal, a matriz **Relatório** e a exportação PDF. Excel exportado e L2 ficam fora da entrega.

Execute da raiz do repositório:

```sh
npm run test:l1
```

Resultado no código atual: **38 testes, 8 arquivos, todos verdes**. Não há relógio, rede ou banco de produção na suíte; consultas da tela e Edge Functions usam dados locais. A função SQL de reimportação é executada em PGlite em memória.

## Dados e camadas

`tests/fixtures/` estava ausente. Esta entrega contém **dois ZIPs mensais sintéticos** (janeiro e fevereiro de 2026), **duas Carteiras Diárias sintéticas** (janeiro), dois fundos fictícios (`00000000000001` e `00000000000002`) e **quatro JSONs de saída esperada**. Cada JSON distingue `result` (motor) de `reportRows` (tela); um quinto JSON preserva separadamente a saída textual e estrutural do PDF de janeiro. Os arquivos têm prefixo `synthetic_`. O gerador `tests/l1/generate-fixtures.mjs` foi usado uma vez para capturar motor e linhas do código atual; `npm run test:l1` nunca o executa nem atualiza snapshots. Janeiro tem posição CPR; fevereiro exercita a ausência de posição.

| Camada | Arquivos de teste | Testes | Evidência |
|---|---|---:|---|
| Parsers e limite ZIP | `parsers.test.ts` | 11 | CSV CVM `;`/ISO-8859-1, CNPJ/mês, 10 tabelas, duplicidade, limites de 15/50 MB, Carteira Diária Windows-1252/data/CNPJ/CPR |
| Motor e bordas | `motor.test.ts` | 13 | 4 comparações exatas de resultado e 74 linhas; 9 comportamentos de borda |
| Seleção e persistência | `position-selection.test.ts`, `selection-persistence.test.ts` | 2 | snapshot por data/horário; SQL real substitui os fatos da competência |
| Relatório | `report-ui.test.tsx` | 2 | 74 linhas, execução `2026.2` mais recente, filtro, comparação, exportação sem filtro |
| PDF | `pdf.test.ts` | 2 | nome, metadados, quatro colunas, 74 linhas por fundo, lacunas, simulação, rodapé |
| `apresentacao` | `report-ui.test.tsx` | 2 | prioridades dos alertas e dados dos gráficos |
| `known-divergence` | `known-divergence.test.ts` | 5 | valores da prévia anterior citados na validação de 23/09/2026 |
| Contrato de cobertura | `coverage.test.ts` | 1 | identidade das 74 linhas nos quatro JSONs; 7 lacunas intencionais |

A [matriz indicador × teste](L1_COBERTURA.md) lista as 74 linhas por **seção + indicador**. Há 47 indicadores ligados a métricas do motor, 20 faixas CVM e 7 linhas sem cálculo. Cada linha aparece nos quatro snapshots e no PDF; a página também é verificada com 74 linhas. As sete lacunas ficam `n/d`, `indisponivel` e com a ressalva existente. Não há linha da matriz sem teste estrutural. As sete linhas sem número dependem de estoque, títulos liquidados ou outro dado que o fluxo atual não possui; a suíte não inventa cálculo para elas.

## Achados preservados, sem correção

- A tela marca bucket ausente como `aproximado` no detalhe, enquanto o exportador PDF o marca `Indisponível`; o valor é `n/d` em ambos. Os testes preservam as duas apresentações.
- Campo opcional da composição de crédito presente e vazio vira zero; coluna obrigatória ausente deixa o cálculo dependente indisponível.
- Tabelas agregadas usam só a primeira linha. A seleção de Carteira Diária usa a maior `reference_date` no mês e, no empate, o maior `imported_at`; isso não prova que seja o último dia útil.
- Top N de sacados soma linhas da TAB VIII sem consolidar identificador; o maior cedente considera até nove posições de cada grupo.
- A faixa aberta `>1080` usa 1080 no prazo médio; dias úteis usam multiplicação por `252/365`.
- A prévia de 2026 mantém diferenças de saídas, vencidos, captações e R$ 447,15 em CVPAR II frente à planilha. Os testes `known-divergence` leem a prévia já existente, pois os ZIPs e o Excel originais não constam de `tests/fixtures/`; não são recálculo independente.
- O teste SQL usa o corpo da função da migration em um esquema mínimo PGlite. Não exercita RLS, Storage ou a instância Supabase.

## Prova de sensibilidade

O teste usou uma **cópia transitória em memória** de `liquidity-monthly.ts`, transformada pelo plugin de teste somente quando `L1_MUTATION` é definido. O arquivo original não foi editado. Cada mutação foi executada isoladamente com `npm run test:l1 -- tests/l1/motor.test.ts`; depois, sem `L1_MUTATION`, a suíte integral voltou a ficar verde.

| Mutação transitória | Resultado | Teste específico que falhou |
|---|---:|---|
| Primeiro ponto médio 15 → 16 | 5 falhas em 13 | `prazo médio usa pontos médios fixos e 252/365` |
| Filtro de taxa `<=300` → `<=10` | 5 falhas em 13 | `taxa de cessão filtra valor positivo e taxa em (0;300]%` |
| Subordinação exige `junior` no lugar de `subordinada` | 5 falhas em 13 | `inclui subordinada mezanino e exclui mezanino sem subordinada` |

Para repetir: defina `L1_MUTATION` como `midpoint`, `rate_filter` ou `subordination` apenas no processo de teste. Cada execução deve falhar; retire a variável e rode `npm run test:l1` para o portão normal.

## Próxima evidência necessária

A suíte atual é um **golden master sintético**. Para cumprir o portão L1 com dados operacionais reais, ainda é preciso receber 2–3 competências completas com ZIP do Informe, Carteira Diária e PDF final produzido, anonimizar se necessário, e acrescentar snapshots revisados pelo Back Office. Não se deve apresentar os cinco testes de divergência da prévia como substituto desses arquivos.
