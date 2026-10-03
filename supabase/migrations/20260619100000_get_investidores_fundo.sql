-- ============================================================
-- Look-through invertido: dado um fundo-alvo, quem o detém
-- diretamente (nível 1) e indiretamente (nível 2+).
--
-- A CTE recursiva sobe pelo grafo de cotas em posicao_carteira.
-- A guarda de ciclo usa o PAR (fundo_cnpj|fundo_isin), não só
-- o CNPJ, para não bloquear tranches distintas (SR/SUB) de um
-- mesmo FIDC que têm o mesmo CNPJ mas ISINs diferentes.
-- ============================================================

create or replace function public.get_investidores_fundo(
  p_cnpj       text,
  p_dtposicao  text,
  p_isin       text     default '',
  p_max_niveis int      default 5
)
returns table (
  caminho_id      text,    -- path completo serializado como "par1→par2→..."
  nivel           int,
  fundo_cnpj      text,
  fundo_isin      text,
  nome_fundo      text,
  pct_pl          numeric, -- participação direta no PL do fundo detentor
  pct_lookthrough numeric  -- exposição acumulada desde o alvo até este nó
)
language sql stable parallel safe as $$
  with recursive subida(
    path_pares,         -- array de "cnpj|isin" — guarda de ciclo + identidade do caminho
    nivel,
    fundo_cnpj,
    fundo_isin,
    nome_fundo,
    pct_pl,
    pct_lookthrough
  ) as (

    -- ── Base: quem detém diretamente o fundo-alvo ─────────────────────────
    select
      array[pc.fundo_cnpj || '|' || coalesce(pc.fundo_isin, '')]  as path_pares,
      1                                                             as nivel,
      pc.fundo_cnpj,
      coalesce(pc.fundo_isin, '')                                   as fundo_isin,
      coalesce(pc.nome_fundo, pc.fundo_nome, pc.fundo_cnpj)        as nome_fundo,
      -- pct_pl: participação direta deste detentor no alvo
      case
        when pc.fundo_patliq > 0 then pc.valor_padrao / pc.fundo_patliq
        else null
      end                                                           as pct_pl,
      -- pct_lookthrough: acumulado = pct_pl no nível base
      case
        when pc.fundo_patliq > 0 then pc.valor_padrao / pc.fundo_patliq
        else null
      end                                                           as pct_lookthrough
    from public.posicao_carteira pc
    where pc.section = 'cotas'
      and pc.fundo_dtposicao = p_dtposicao
      and public.normalize_cnpj_digits(coalesce(pc.cnpjfundo, pc.cnpjemissor))
            = public.normalize_cnpj_digits(p_cnpj)
      and coalesce(pc.isin, '') = coalesce(nullif(p_isin, ''), coalesce(pc.isin, ''), '')

    union all

    -- ── Recursão: quem detém os nós do nível anterior ─────────────────────
    select
      s.path_pares || (pc.fundo_cnpj || '|' || coalesce(pc.fundo_isin, '')),
      s.nivel + 1,
      pc.fundo_cnpj,
      coalesce(pc.fundo_isin, ''),
      coalesce(pc.nome_fundo, pc.fundo_nome, pc.fundo_cnpj),
      case
        when pc.fundo_patliq > 0 then pc.valor_padrao / pc.fundo_patliq
        else null
      end,
      -- pct_lookthrough acumulado: multiplica percentuais ao longo do caminho
      case
        when pc.fundo_patliq > 0 and s.pct_lookthrough is not null
          then s.pct_lookthrough * (pc.valor_padrao / pc.fundo_patliq)
        else null
      end
    from public.posicao_carteira pc
    join subida s
      on public.normalize_cnpj_digits(coalesce(pc.cnpjfundo, pc.cnpjemissor))
           = public.normalize_cnpj_digits(s.fundo_cnpj)
     and coalesce(pc.isin, '') = s.fundo_isin
    where pc.section = 'cotas'
      and pc.fundo_dtposicao = p_dtposicao
      and s.nivel < p_max_niveis
      -- guarda de ciclo por par (cnpj|isin): bloqueia loops sem cortar tranches distintas
      and not (
        (pc.fundo_cnpj || '|' || coalesce(pc.fundo_isin, '')) = any(s.path_pares)
      )
  )

  select
    array_to_string(path_pares, '→') as caminho_id,
    nivel,
    fundo_cnpj,
    fundo_isin,
    nome_fundo,
    pct_pl,
    pct_lookthrough
  from subida
  order by caminho_id, nivel
$$;

comment on function public.get_investidores_fundo is
  'Look-through invertido: retorna todos os fundos que chegam ao fundo-alvo (p_cnpj, p_isin) por caminhos de cotas na data p_dtposicao. Cada linha pertence a um caminho (caminho_id) e ao nível correspondente. Use detectarConvergencia() no frontend para agregar caminhos com mesmo nó terminal.';
