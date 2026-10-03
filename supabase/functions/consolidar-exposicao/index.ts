import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type AtivoJoin = {
  nome_frontend?: string | null;
  descricao?: string | null;
} | null;

type PositionRow = {
  id: string;
  fundo_cnpj: string | null;
  fundo_nome: string | null;
  nome_fundo: string | null;
  section: string | null;
  valor_padrao: number | null;
  cnpjfundo: string | null;
  cnpjemissor: string | null;
  isin: string | null;
  codativo: string | null;
  ativos?: AtivoJoin | AtivoJoin[];
};

type CaractRow = {
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  nivel1_categoria: string | null;
  nome_comercial: string | null;
};

type FundoDetalhe = {
  nome: string;
  valor: number;
  pct: number;
};

type ExposicaoProduto = {
  produto: string;
  valorDireto: number;
  valorIndireto: number;
  valorTotal: number;
  pctPL: number;
  ativosDetalhe: ProdutoAtivoDetalhe[];
  ativosIntermediarios: ProdutoAtivoDetalhe[];
};

type ProdutoAtivoDetalhe = {
  // Novo shape esperado pela UI/API
  nomeAtivo: string;
  codigo: string | null;
  tipo: string;
  valor: number;
  percentualPL: number;
  fundos: FundoDetalheProduto[];
  isIntermediario?: boolean;
  // Campos legados (mantidos por compatibilidade)
  nome: string;
  direto: number;
  indireto: number;
  total: number;
  pct: number;
};

type FundoDetalheProduto = {
  nomeFundo: string;
  valor: number;
  percentual: number;
  valorDireto: number;
  valorIndireto: number;
};

type TopAtivo = {
  rank: number;
  id: string;
  nome: string;
  tipo: string;
  isin: string | null;
  valor: number;
  pctPL: number;
  fundos: string[];
  fundosDetalhe: FundoDetalhe[];
};

type TopCota = {
  rank: number;
  cnpj: string;
  nome: string;
  isin: string | null;
  valor: number;
  pctPL: number;
  qtdFundos: number;
  fundosDetalhe: FundoDetalhe[];
};

type RequestBody = {
  dtposicao: string;
  fundo_cnpj?: string | null;
};

const SECOES_PL = new Set([
  'cotas',
  'titpublico',
  'titprivado',
  'caixa',
  'participacoes',
  'acoes',
  'imoveis',
  'fidc',
  'termorf',
]);

function normalizeCnpj(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(14, '0');
}

function normalizeSection(v: string | null | undefined): string {
  return String(v ?? '').toLowerCase().trim();
}

function sectionToProduto(section: string): string {
  switch (section) {
    case 'titpublico':   return 'Titulos Publicos';
    case 'titprivado':   return 'Titulos Privados';
    case 'caixa':        return 'Caixa / Liquidez';
    case 'acoes':        return 'Acoes';
    case 'fidc':         return 'FIDC';
    case 'participacoes':return 'FIP / Participacoes';
    case 'imoveis':      return 'Imoveis';
    case 'termorf':      return 'Termo / Compromissadas';
    case 'cotas':        return 'Cotas de Fundos';
    default:             return 'Outros';
  }
}

function getAtivoNome(row: PositionRow): string | null {
  const ativoJoin = Array.isArray(row.ativos) ? row.ativos[0] : row.ativos;
  return ativoJoin?.nome_frontend || ativoJoin?.descricao || null;
}

function categoriaToProduto(categoria: string | null | undefined): string {
  const normalized = String(categoria ?? '').toUpperCase().replace(/\s/g, '');
  if (normalized.includes('FIP') || normalized.includes('PARTICIP')) return 'FIP / Participacoes';
  if (normalized.includes('FIDC'))                                    return 'FIDC';
  if (normalized.includes('IMOBILI') || normalized.includes('FII'))  return 'Imoveis';
  if (normalized.includes('ACOES'))                                   return 'Acoes';
  if (normalized.includes('RENDAFIXA'))                               return 'Titulos Privados';
  return 'Cotas de Fundos';
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as RequestBody;
    const dtposicao = String(body.dtposicao ?? '').trim();
    const fundoCnpjFilter = normalizeCnpj(body.fundo_cnpj ?? null);

    if (!dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'dtposicao is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Busca dados completos (sem filtro de gestor) para look-through recursivo
    const [{ data: posicoes, error: posErr }, { data: paresMonitorados, error: paresErr }] = await Promise.all([
      supabase
        .from('posicao_carteira')
        .select('id, fundo_cnpj, fundo_nome, nome_fundo, section, valor_padrao, cnpjfundo, cnpjemissor, isin, codativo, ativos(nome_frontend, descricao)')
        .eq('fundo_dtposicao', dtposicao),
      // RPC retorna pares monitorados (allowlist de gestoras) — usado só para filtrar rootFunds
      supabase.rpc('get_pares_fundo_monitorado', { p_dtposicao: dtposicao }),
    ]);

    if (posErr) throw posErr;
    if (paresErr) throw paresErr;

    // Set de CNPJs monitorados (sem ISIN — rootFunds usa apenas CNPJ)
    const monitoradosSet = new Set<string>(
      (paresMonitorados ?? []).map((p: { fundo_cnpj: string }) => normalizeCnpj(p.fundo_cnpj) ?? '')
        .filter(Boolean)
    );

    const allRows = (posicoes ?? []) as PositionRow[];
    if (allRows.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { exposicaoPorProduto: [], topAtivos: [], topCotas: [], totalPL: 0, nivelMaximoAtingido: 0 },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const rowsByFund = new Map<string, PositionRow[]>();
    const fundNameMap = new Map<string, string>();
    for (const row of allRows) {
      const fc = normalizeCnpj(row.fundo_cnpj);
      if (!fc) continue;
      if (!rowsByFund.has(fc)) rowsByFund.set(fc, []);
      rowsByFund.get(fc)!.push(row);
      if (!fundNameMap.has(fc)) {
        fundNameMap.set(fc, row.nome_fundo || row.fundo_nome || fc);
      }
    }

    // Fundos que são investidos como cotas por outros fundos importados -> não são raiz
    const fundosFilhos = new Set<string>();
    for (const rows of rowsByFund.values()) {
      for (const row of rows) {
        if (normalizeSection(row.section) !== 'cotas') continue;
        const cnpjFilho = normalizeCnpj(row.cnpjfundo || row.cnpjemissor);
        if (!cnpjFilho) continue;
        if (rowsByFund.has(cnpjFilho)) fundosFilhos.add(cnpjFilho);
      }
    }

    // Consolidado: fundos raiz = não são filhos de outros E pertencem à allowlist de gestores
    // (monitoradosSet vazio = tabela não populada, retorna todos para não quebrar)
    let rootFunds = [...rowsByFund.keys()].filter(
      (c) => !fundosFilhos.has(c) && (monitoradosSet.size === 0 || monitoradosSet.has(c))
    );
    if (fundoCnpjFilter) {
      // Modo fundo individual: qualquer fundo (inclusive externo), sem filtro de gestor
      rootFunds = [...rowsByFund.keys()].filter((c) => c === fundoCnpjFilter);
    }

    if (rootFunds.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { exposicaoPorProduto: [], topAtivos: [], topCotas: [], totalPL: 0, nivelMaximoAtingido: 0 },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const cnpjInvestidos = new Set<string>();
    for (const row of allRows) {
      const c = normalizeCnpj(row.cnpjfundo || row.cnpjemissor);
      if (c) cnpjInvestidos.add(c);
    }

    const cnpjsForCaract = [...cnpjInvestidos];
    const caractMap = new Map<string, CaractRow>();
    if (cnpjsForCaract.length > 0) {
      const { data: byClasse } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, nivel1_categoria, nome_comercial')
        .in('cnpj_classe', cnpjsForCaract)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');
      const { data: byFundo } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, nivel1_categoria, nome_comercial')
        .in('cnpj_fundo', cnpjsForCaract)
        .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo');

      for (const c of [...(byClasse || []), ...(byFundo || [])] as CaractRow[]) {
        const cClasse = normalizeCnpj(c.cnpj_classe);
        const cFundo  = normalizeCnpj(c.cnpj_fundo);
        if (cClasse) caractMap.set(cClasse, c);
        if (cFundo)  caractMap.set(cFundo, c);
      }
    }

    const plByFund = new Map<string, number>();
    for (const [fund, rows] of rowsByFund) {
      let pl = 0;
      for (const row of rows) {
        const sec = normalizeSection(row.section);
        if (!SECOES_PL.has(sec)) continue;
        pl += Number(row.valor_padrao ?? 0) || 0;
      }
      plByFund.set(fund, pl);
    }

    // --- accumulators --------------------------------------------------------
    type TopAccEntry = {
      nome: string; tipo: string; isin: string | null;
      valor: number; fundos: Set<string>; fundosValor: Map<string, number>;
    };
    const produtoAcc = new Map<string, { direto: number; indireto: number }>();
    const produtoAtivoAcc = new Map<string, Map<string, {
      nomeAtivo: string;
      codigo: string | null;
      tipo: string;
      direto: number;
      indireto: number;
      fundosValor: Map<string, number>;
      fundosDireto: Map<string, number>;
      fundosIndireto: Map<string, number>;
    }>>();
    const produtoIntermediarioAcc = new Map<string, Map<string, {
      nomeAtivo: string;
      codigo: string | null;
      tipo: string;
      direto: number;
      indireto: number;
      fundosValor: Map<string, number>;
      fundosDireto: Map<string, number>;
      fundosIndireto: Map<string, number>;
    }>>();
    const topAcc     = new Map<string, TopAccEntry>();

    // Cotas agregadas por CNPJ do fundo investido (independente de qual fundo-raiz investe)
    type CotaAccEntry = {
      nome: string; isin: string | null;
      valor: number; fundosValor: Map<string, number>;
    };
    const cotasAgg = new Map<string, CotaAccEntry>();

    const visiting = new Set<string>();
    let nivelMaximoAtingido = 0;

    function addProduto(produto: string, valor: number, isDirect: boolean) {
      const acc = produtoAcc.get(produto) ?? { direto: 0, indireto: 0 };
      if (isDirect) acc.direto += valor; else acc.indireto += valor;
      produtoAcc.set(produto, acc);
    }

    function addProdutoAtivo(
      produto: string,
      key: string,
      nomeAtivo: string,
      codigo: string | null,
      tipo: string,
      valor: number,
      isDirect: boolean,
      rootFundNome: string
    ) {
      if (!produtoAtivoAcc.has(produto)) produtoAtivoAcc.set(produto, new Map());
      const m = produtoAtivoAcc.get(produto)!;
      const e = m.get(key) ?? {
        nomeAtivo,
        codigo,
        tipo,
        direto: 0,
        indireto: 0,
        fundosValor: new Map<string, number>(),
        fundosDireto: new Map<string, number>(),
        fundosIndireto: new Map<string, number>(),
      };
      if (isDirect) e.direto += valor; else e.indireto += valor;
      e.fundosValor.set(rootFundNome, (e.fundosValor.get(rootFundNome) ?? 0) + valor);
      if (isDirect) {
        e.fundosDireto.set(rootFundNome, (e.fundosDireto.get(rootFundNome) ?? 0) + valor);
      } else {
        e.fundosIndireto.set(rootFundNome, (e.fundosIndireto.get(rootFundNome) ?? 0) + valor);
      }
      m.set(key, e);
    }

    function addProdutoIntermediario(
      produto: string,
      key: string,
      nomeAtivo: string,
      codigo: string | null,
      tipo: string,
      valor: number,
      isDirect: boolean,
      rootFundNome: string
    ) {
      if (!produtoIntermediarioAcc.has(produto)) produtoIntermediarioAcc.set(produto, new Map());
      const m = produtoIntermediarioAcc.get(produto)!;
      const e = m.get(key) ?? {
        nomeAtivo,
        codigo,
        tipo,
        direto: 0,
        indireto: 0,
        fundosValor: new Map<string, number>(),
        fundosDireto: new Map<string, number>(),
        fundosIndireto: new Map<string, number>(),
      };
      if (isDirect) e.direto += valor; else e.indireto += valor;
      e.fundosValor.set(rootFundNome, (e.fundosValor.get(rootFundNome) ?? 0) + valor);
      if (isDirect) {
        e.fundosDireto.set(rootFundNome, (e.fundosDireto.get(rootFundNome) ?? 0) + valor);
      } else {
        e.fundosIndireto.set(rootFundNome, (e.fundosIndireto.get(rootFundNome) ?? 0) + valor);
      }
      m.set(key, e);
    }

    function addTopAtivo(
      key: string, nome: string, tipo: string, isin: string | null,
      valor: number, rootFundNome: string
    ) {
      let acc = topAcc.get(key);
      if (!acc) {
        acc = { nome, tipo, isin, valor: 0, fundos: new Set(), fundosValor: new Map() };
        topAcc.set(key, acc);
      }
      acc.valor += valor;
      acc.fundos.add(rootFundNome);
      acc.fundosValor.set(rootFundNome, (acc.fundosValor.get(rootFundNome) ?? 0) + valor);
    }

    function addCota(
      cnpj: string, nome: string, isin: string | null,
      valor: number, rootFundNome: string
    ) {
      let acc = cotasAgg.get(cnpj);
      if (!acc) {
        acc = { nome, isin, valor: 0, fundosValor: new Map() };
        cotasAgg.set(cnpj, acc);
      }
      acc.valor += valor;
      acc.fundosValor.set(rootFundNome, (acc.fundosValor.get(rootFundNome) ?? 0) + valor);
    }

    // --- recursive look-through ----------------------------------------------
    function expandirFundo(currentFundCnpj: string, peso: number, depth: number, rootFundCnpj: string) {
      if (depth > 5) return;
      if (depth > nivelMaximoAtingido) nivelMaximoAtingido = depth;
      const nodeKey = `${currentFundCnpj}:${depth}`;
      if (visiting.has(nodeKey)) return;
      visiting.add(nodeKey);

      const rows      = rowsByFund.get(currentFundCnpj) ?? [];
      const currentPL = plByFund.get(currentFundCnpj) ?? 0;
      const rootNome  = fundNameMap.get(rootFundCnpj) || rootFundCnpj;
      // Fundo cujo XML contém esta linha (detentor imediato) — necessário para Top 10 / cotas
      const holderNome = fundNameMap.get(currentFundCnpj) || currentFundCnpj;

      for (const row of rows) {
        const sec = normalizeSection(row.section);
        if (!SECOES_PL.has(sec)) continue;
        const valorRow = Number(row.valor_padrao ?? 0) || 0;
        if (valorRow <= 0) continue;
        const valorPonderado = valorRow * peso;
        const isDirect = depth === 0;

        if (sec === 'cotas') {
          const investeeCnpj = normalizeCnpj(row.cnpjfundo || row.cnpjemissor);
          const categoriaInter = investeeCnpj ? caractMap.get(investeeCnpj)?.nivel1_categoria : null;
          const produtoInter = categoriaToProduto(categoriaInter);
          const nomeInter =
            getAtivoNome(row) ||
            (investeeCnpj ? caractMap.get(investeeCnpj)?.nome_comercial : null) ||
            fundNameMap.get(investeeCnpj ?? '') ||
            investeeCnpj ||
            'Cota de Fundo';
          const codigoInter = row.isin || investeeCnpj || row.codativo || null;
          const interKey = `inter:${investeeCnpj || row.id}`;

          // Tenta expandir recursivamente se temos posição interna do fundo
          if (investeeCnpj && rowsByFund.has(investeeCnpj) && depth < 5) {
            const investeePL = plByFund.get(investeeCnpj) ?? 0;
            if (investeePL > 0 && currentPL > 0) {
              // Registramos o intermediário somente para visualização opcional (não soma no total do produto)
              addProdutoIntermediario(produtoInter, interKey, nomeInter, codigoInter, 'COTAS_INTERMEDIARIO', valorPonderado, isDirect, rootNome);
              const ownership = valorRow / investeePL;
              expandirFundo(investeeCnpj, peso * ownership, depth + 1, rootFundCnpj);
              visiting.delete(nodeKey);
              visiting.add(nodeKey); // mantém o guard para este nível
              continue;
            }
          }

          // Folha: cota não expandível
          const categoria   = investeeCnpj ? caractMap.get(investeeCnpj)?.nivel1_categoria : null;
          const produtoLeaf = categoriaToProduto(categoria);
          addProduto(produtoLeaf, valorPonderado, isDirect);

          const nomeCota = nomeInter;

          // Top 10 (chave por ocorrência mantendo multiplicidade para fundos diferentes)
          const topKey = `cota:${investeeCnpj || row.id}`;
          addTopAtivo(topKey, nomeCota, 'cotas', row.isin, valorPonderado, holderNome);
          const codigoCota = codigoInter;
          addProdutoAtivo(produtoLeaf, topKey, nomeCota, codigoCota, 'COTAS', valorPonderado, isDirect, rootNome);

          // Agregação de cotas (sempre por CNPJ do investido)
          if (investeeCnpj) {
            addCota(investeeCnpj, nomeCota, row.isin, valorPonderado, holderNome);
          }
          continue;
        }

        const produto   = sectionToProduto(sec);
        addProduto(produto, valorPonderado, isDirect);

        const nomeAtivo = getAtivoNome(row) || row.codativo || row.isin || sec || 'Ativo';
        const topKey    = row.isin || normalizeCnpj(row.cnpjemissor) || row.codativo || `${sec}:${row.id}`;
        addTopAtivo(topKey, nomeAtivo, sec, row.isin, valorPonderado, holderNome);
        const codigoAtivo = row.isin || normalizeCnpj(row.cnpjemissor) || row.codativo || null;
        addProdutoAtivo(produto, topKey, nomeAtivo, codigoAtivo, sec.toUpperCase(), valorPonderado, isDirect, rootNome);
      }

      visiting.delete(nodeKey);
    }

    for (const root of rootFunds) {
      expandirFundo(root, 1, 0, root);
    }

    const totalPL = rootFunds.reduce((sum, c) => sum + (plByFund.get(c) ?? 0), 0);

    // --- build output --------------------------------------------------------
    function buildFundosDetalhe(fundosValor: Map<string, number>, totalValor: number): FundoDetalhe[] {
      return [...fundosValor.entries()]
        .map(([nome, valor]) => ({ nome, valor, pct: totalValor > 0 ? valor / totalValor : 0 }))
        .sort((a, b) => b.valor - a.valor);
    }

    const exposicaoPorProduto: ExposicaoProduto[] = [...produtoAcc.entries()]
      .map(([produto, v]) => {
        const valorTotal = v.direto + v.indireto;
        const ativoMap = produtoAtivoAcc.get(produto) ?? new Map<string, {
          nomeAtivo: string;
          codigo: string | null;
          tipo: string;
          direto: number;
          indireto: number;
          fundosValor: Map<string, number>;
          fundosDireto: Map<string, number>;
          fundosIndireto: Map<string, number>;
        }>();
        const ativosDetalhe: ProdutoAtivoDetalhe[] = [...ativoMap.values()]
          .map((a) => ({
            nomeAtivo: a.nomeAtivo,
            codigo: a.codigo,
            tipo: a.tipo,
            direto: a.direto,
            indireto: a.indireto,
            total: a.direto + a.indireto,
            pct: valorTotal > 0 ? (a.direto + a.indireto) / valorTotal : 0,
            valor: a.direto + a.indireto,
            percentualPL: totalPL > 0 ? (a.direto + a.indireto) / totalPL : 0,
            fundos: [...a.fundosValor.entries()]
              .map(([nomeFundo, valorFundo]) => ({
                nomeFundo,
                valor: valorFundo,
                percentual: (a.direto + a.indireto) > 0 ? valorFundo / (a.direto + a.indireto) : 0,
                valorDireto: a.fundosDireto.get(nomeFundo) ?? 0,
                valorIndireto: a.fundosIndireto.get(nomeFundo) ?? 0,
              }))
              .sort((x, y) => y.valor - x.valor),
            // legados
            nome: a.nomeAtivo,
          }))
          .sort((a, b) => b.total - a.total);
        const interMap = produtoIntermediarioAcc.get(produto) ?? new Map<string, {
          nomeAtivo: string;
          codigo: string | null;
          tipo: string;
          direto: number;
          indireto: number;
          fundosValor: Map<string, number>;
          fundosDireto: Map<string, number>;
          fundosIndireto: Map<string, number>;
        }>();
        const ativosIntermediarios: ProdutoAtivoDetalhe[] = [...interMap.values()]
          .map((a) => ({
            nomeAtivo: a.nomeAtivo,
            codigo: a.codigo,
            tipo: a.tipo,
            direto: a.direto,
            indireto: a.indireto,
            total: a.direto + a.indireto,
            pct: valorTotal > 0 ? (a.direto + a.indireto) / valorTotal : 0,
            valor: a.direto + a.indireto,
            percentualPL: totalPL > 0 ? (a.direto + a.indireto) / totalPL : 0,
            fundos: [...a.fundosValor.entries()]
              .map(([nomeFundo, valorFundo]) => ({
                nomeFundo,
                valor: valorFundo,
                percentual: (a.direto + a.indireto) > 0 ? valorFundo / (a.direto + a.indireto) : 0,
                valorDireto: a.fundosDireto.get(nomeFundo) ?? 0,
                valorIndireto: a.fundosIndireto.get(nomeFundo) ?? 0,
              }))
              .sort((x, y) => y.valor - x.valor),
            isIntermediario: true,
            nome: a.nomeAtivo,
          }))
          .sort((a, b) => b.total - a.total);
        // Não truncar: garante que soma dos detalhes bata com o total do produto
        return {
          produto,
          valorDireto: v.direto,
          valorIndireto: v.indireto,
          valorTotal,
          pctPL: totalPL > 0 ? valorTotal / totalPL : 0,
          ativosDetalhe,
          ativosIntermediarios,
        };
      })
      .sort((a, b) => b.valorTotal - a.valorTotal);

    const topAtivos: TopAtivo[] = [...topAcc.entries()]
      .map(([id, v]) => ({
        id,
        rank: 0,
        nome: v.nome,
        tipo: v.tipo,
        isin: v.isin,
        valor: v.valor,
        pctPL: totalPL > 0 ? v.valor / totalPL : 0,
        fundos: [...v.fundos].sort(),
        fundosDetalhe: buildFundosDetalhe(v.fundosValor, v.valor),
      }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10)
      .map((row, i) => ({ ...row, rank: i + 1 }));

    const topCotas: TopCota[] = [...cotasAgg.entries()]
      .map(([cnpj, v]) => ({
        rank: 0,
        cnpj,
        nome: v.nome,
        isin: v.isin,
        valor: v.valor,
        pctPL: totalPL > 0 ? v.valor / totalPL : 0,
        qtdFundos: v.fundosValor.size,
        fundosDetalhe: buildFundosDetalhe(v.fundosValor, v.valor),
      }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 20)
      .map((row, i) => ({ ...row, rank: i + 1 }));

    return new Response(
      JSON.stringify({
        success: true,
        data: { exposicaoPorProduto, topAtivos, topCotas, totalPL, nivelMaximoAtingido },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null
          ? JSON.stringify(error)
          : String(error);
    console.error('[consolidar-exposicao] Error:', msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
