# Relatório de estoque + XML — metodologia `cvpar_fidc_estoque_xml@2026.1`

Esta metodologia indicativa é separada de `cvpar_fidc_mensal@2026.2`. O motor, a aba Relatório e o PDF dessa versão congelada não são alterados. O cálculo usa somente o **Estoque FIDC** normalizado e o **XML da posição** do mesmo CNPJ e da mesma data-base. Não usa o Informe Mensal CVM. O estoque cobre recebíveis do fundo; o XML importado pode cobrir apenas uma classe/posição desse fundo.

Na verificação de julho/2026, o `fundo_patliq` dos XMLs de CVPAR I e II coincide com o valor da classe subordinada no informe mensal, não com o PL consolidado. Essa comparação serviu **somente para identificar o perímetro**; nenhum valor do informe entra neste cálculo. Até haver XMLs de todas as classes ou outra fonte consolidada, `PL do fundo` e quaisquer razões que misturem estoque do fundo com ativos/PL da classe são `n/d`.

## Contrato das fontes

| Indicador | Fonte e campo | Regra |
|---|---|---|
| PL da posição/classe XML | XML `fundo_patliq` | Exige valor positivo idêntico nas linhas do arquivo. **Não é PL consolidado do fundo.** |
| Administração paga pela posição/classe | XML `despesas.txadm` | Exige uma linha `despesas`; valor financeiro pago no mês, em regime de caixa. `perctaxaadm` é percentual anual e não substitui o valor. Não presumir despesa consolidada do fundo. |
| Estoque bruto | Estoque `valor_presente` | Soma de todos os registros da importação concluída, sem reclassificar tipo de recebível como DC contábil. |
| PDD | Estoque `valor_pdd` | Negativo da soma; se houver valor ausente ou negativo, o total fica indisponível. |
| Estoque líquido indicativo | Estoque | `valor_presente − valor_pdd`. Não equivale automaticamente ao valor contábil do XML. |
| Vencidos | Estoque `situacao_recebivel` | Soma de `valor_presente` quando a situação é `Vencido`. |
| A vencer e faixas | Estoque `situacao_recebivel`, `data_vencimento_ajustada` | Usa `A vencer` e dias corridos até a posição: 0–5, 6–30 e as dez faixas do relatório. É vencimento contratual, não previsão de recebimento. |
| Faixas de atraso | Estoque | Usa `Vencido` com data anterior à posição. Divergência entre situação e data aparece como ressalva; o valor permanece no total por situação e fica fora da faixa. |
| Prazo médio | Estoque | Dias corridos até o vencimento ajustado, ponderados por `valor_presente` dos títulos `A vencer`; dias úteis = corridos × 252/365. |
| Taxa de cessão | Estoque `taxa_cessao`, `valor_aquisicao` | Taxa em fração anual, ponderada por valor de aquisição positivo; aceita somente taxas em (0;300%]. Mensal = `(1 + anual)^(1/12) − 1`. |
| Top sacados/cedentes | Estoque `doc_sacado`/`doc_cedente`, `valor_presente` | Consolida CPF/CNPJ do arquivo e divide a soma dos maiores 1/5/10/15 pelo **estoque bruto**. Inclui vencidos. Documento ausente torna a concentração indisponível. |
| Caixa e títulos da posição/classe | XML `caixa.saldo`, `titpublico.valor_padrao`, `titprivado.valor_padrao` | Somas contábeis apenas do XML importado; caixa negativo mantém sinal. Prazo de negociação não é inferido. |
| Cotas próprias / outras da posição/classe | XML `cotas.cnpjfundo`, `valor_padrao` | Separa CNPJ igual ao fundo dos demais. Não somar ao estoque nem comparar diretamente com o estoque líquido do fundo. Cotas de outros fundos não são presumidas líquidas. |

PL consolidado, estoque/PL, PDD/PL, captações, resgates, amortizações, recompras, custódia e gestão por natureza, subordinação, mínimo vigente e cobertura de resgates permanecem **indisponíveis** com essas duas fontes. A única razão de 30 dias desta metodologia é `estoque a vencer até 30 dias / estoque bruto`, uma proporção de vencimento contratual, não caixa projetado ou cobertura.

O XML pode incluir a carteira em mais de uma seção. Somar `titprivado`, `cotas` e o estoque sem conciliação duplicaria exposições. Cotas próprias do XML e estoque líquido possuem perímetros diferentes, por isso a diferença entre eles não é calculada como indicador.

O importador atual do estoque registra ID e nome do arquivo, mas não o SHA-256 do arquivo original. O relatório local usa hash dos registros normalizados e assinala essa lacuna. Nenhuma execução desta metodologia representa fechamento ou aprovação mensal; a autoridade responsável será validada depois.

O [manual de preenchimento do arquivo de posição da ANBIMA](https://www.anbima.com.br/data/files/3F/F4/4E/72/27E38510738DD08568A80AC2/Manual-de-Preenchimento_Arquivo-de-Posi__o-4.0.1_1_.pdf), seção Despesas (Taxas), fundamenta a leitura de `txadm` como valor pago no mês em regime de caixa e distingue `perctaxaadm` como percentual anual.
