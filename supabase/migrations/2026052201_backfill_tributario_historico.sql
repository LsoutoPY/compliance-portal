-- Backfill enquadramento_tributario_historico a partir dos snapshots já salvos
-- (enquadramento_resultado / TRIB_FIQ_LP_90). Rode após corrigir rules-tributario.

INSERT INTO public.enquadramento_tributario_historico (
  fundo_cnpj,
  data_referencia,
  p_dia,
  mm_10d,
  em_violacao,
  eventos_ano,
  dias_violacao_ano,
  valor_lp,
  valor_cp,
  valor_excluido,
  pl_total
)
SELECT
  LPAD(REGEXP_REPLACE(r.fundo_cnpj, '\D', '', 'g'), 14, '0') AS fundo_cnpj,
  TO_DATE(
    SUBSTRING(REGEXP_REPLACE(r.fundo_dtposicao, '\D', '', 'g') FROM 1 FOR 8),
    'YYYYMMDD'
  ) AS data_referencia,
  (r.detalhes->>'p_dia')::numeric AS p_dia,
  COALESCE(
    (r.detalhes->>'mm_10d')::numeric,
    r.valor_atual * 100
  ) AS mm_10d,
  COALESCE(
    (r.detalhes->>'mm_10d')::numeric,
    r.valor_atual * 100
  ) < 90 AS em_violacao,
  COALESCE((r.detalhes->>'eventos_ano')::integer, 0) AS eventos_ano,
  COALESCE((r.detalhes->>'dias_violacao_ano')::integer, 0) AS dias_violacao_ano,
  (r.detalhes->>'valor_lp')::numeric AS valor_lp,
  (r.detalhes->>'valor_cp')::numeric AS valor_cp,
  (r.detalhes->>'valor_excluido')::numeric AS valor_excluido,
  COALESCE(
    (r.detalhes->>'pl_total')::numeric,
    (r.detalhes->>'patliq')::numeric
  ) AS pl_total
FROM public.enquadramento_resultado r
WHERE r.regra_codigo = 'TRIB_FIQ_LP_90'
  AND r.detalhes->>'p_dia' IS NOT NULL
  AND LENGTH(REGEXP_REPLACE(r.fundo_dtposicao, '\D', '', 'g')) >= 8
ON CONFLICT (fundo_cnpj, data_referencia) DO UPDATE SET
  p_dia             = EXCLUDED.p_dia,
  mm_10d            = EXCLUDED.mm_10d,
  em_violacao       = EXCLUDED.em_violacao,
  eventos_ano       = EXCLUDED.eventos_ano,
  dias_violacao_ano = EXCLUDED.dias_violacao_ano,
  valor_lp          = EXCLUDED.valor_lp,
  valor_cp          = EXCLUDED.valor_cp,
  valor_excluido    = EXCLUDED.valor_excluido,
  pl_total          = EXCLUDED.pl_total;
