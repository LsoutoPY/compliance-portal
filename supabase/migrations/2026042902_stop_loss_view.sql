-- ============================================================
-- Stop Loss 21d — View de painel
-- ============================================================
-- Une controle_cotas_metricas + carteiras + resultado_stress
-- para entregar a linha de stop loss por carteira por data.
--
-- Campos-chave:
--   stop_21d         ← controle_cotas_metricas.retorno_21d_simples
--                      (cota_D0 / cota_D-21 - 1, já calculado por
--                      recalculate-controle-cotas-metricas)
--                      ATENÇÃO: métrica baseada em cota bruta (sem ajuste
--                      por rendimentos/amortizações de FIIs). Para FIIs
--                      o valor pode ser enganoso quando houve distribuição
--                      no período.
--
--   consumo_stop_21d ← GREATEST(0, stop_21d / stress_num)
--                      Clamped em 0: retorno positivo (ganho) não consome
--                      o limite. O sinal da divisão inverteria erroneamente
--                      quando stop_21d > 0 e stress_num < 0.
--
--   stress_perda_pct ← resultado_stress.perda_pct WHERE
--                      cenario_nome = 'Pior Histórico 21d'
--   consumo_stress   ← resultado_stress.pct_utilizado (já calculado)
-- ============================================================

CREATE OR REPLACE VIEW vw_stop_loss_painel AS
SELECT DISTINCT ON (ccm.cliente, ccm.data_posicao)
  ccm.data_posicao,
  ccm.cliente,
  c.cod_cli,
  c.nome              AS nom_cli,
  c.officer,
  c.grupo,
  c.stress_num,
  c.stress_contrato,

  -- Retorno real 21 dias úteis: (cota_D0 / cota_D-21) - 1
  -- Nota: cota bruta sem ajuste por dividendos/amortizações.
  ccm.retorno_21d_simples       AS stop_21d,
  -- Retorno com janela parcial (início da série, < 21 obs disponíveis)
  ccm.retorno_ate_21d_simples   AS stop_21d_parcial,
  ccm.janela_21d_completa,
  ccm.qtd_obs_21d,

  -- % de consumo do limite.
  -- GREATEST(0, ...) evita falso CRÍTICO quando o fundo ganhou valor:
  --   stop_21d > 0 e stress_num < 0 → divisão seria negativa → abs() → CRÍTICO indevido.
  -- Ganho real nunca consome o limite de stop loss.
  CASE
    WHEN c.stress_num IS NOT NULL
     AND c.stress_num <> 0
     AND ccm.retorno_21d_simples IS NOT NULL
    THEN GREATEST(0.0, ccm.retorno_21d_simples / c.stress_num)
    ELSE NULL
  END AS consumo_stop_21d,

  -- Stress "Pior Histórico 21d" — cenário já calculado em resultado_stress
  rs.perda_pct        AS stress_perda_pct,
  rs.pct_utilizado    AS consumo_stress,
  rs.status           AS stress_status,
  rs.folga_rs,
  rs.pl_ref,
  rs.pl_atual

FROM controle_cotas_metricas ccm
LEFT JOIN carteiras c
  ON c.nome = ccm.cliente
  OR c.cod_cli::text = ccm.cliente
LEFT JOIN resultado_stress rs
  ON  rs.cod_cli      = c.cod_cli
  AND rs.data_calculo = ccm.data_posicao
  AND rs.cenario_nome = 'Pior Histórico 21d'
WHERE c.ativo = true
  AND c.cod_cli IS NOT NULL
ORDER BY ccm.cliente, ccm.data_posicao DESC;

-- Obrigatório: sem GRANT a anon key não enxerga a view
GRANT SELECT ON vw_stop_loss_painel TO anon, authenticated, service_role;
