ALTER TABLE public.ativos
ADD COLUMN IF NOT EXISTS data_liquidez_prevista date;

COMMENT ON COLUMN public.ativos.data_liquidez_prevista IS
'Data prevista de geracao de caixa (liquidez). Override manual para ativos sem data no XML (ex.: participacoes de FIP/investidas). Tem prioridade sobre prazo_liquidez_manual_dias na resolucao de vertice.';
