import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ────────────────────────────────────────────────────────────────────────────
// Mapeamento de colunas do layout LayCrtDia (Finvest CSV, separado por ";")
// ────────────────────────────────────────────────────────────────────────────
const COL = {
  SEQ: 0,
  LAYOUT: 1,
  TYPE: 2,           // "V" = dado, "C" = cabeçalho
  FUNDO_CNPJ: 3,     // CodigoCrt (8 dígitos parciais do CNPJ)
  FUNDO_NOME: 4,     // NomeCrt
  TIPO_FUNDO: 7,     // TpCrt
  MOEDA: 8,
  ADMINISTRADOR: 9,
  DATA: 10,          // DataEmis  DD/MM/YYYY
  TITULO: 11,        // código do ativo  (ex: CF 09215250, BANCO, VAL A RECEB)
  NOME: 12,          // Nome curto
  ESPEC: 13,         // Especificação
  QT: 14,
  QT_BLOQ: 15,
  QT_DISP: 16,
  PU_CST: 17,
  VL_CST: 18,
  PU_MRC: 19,
  VL_MRC: 20,
  DATA_VENC: 22,
  GRP_N1: 47,        // código macro (10000=ATIVO, 20000=PASSIVO)
  NO_GRP_N1: 48,
  GRP_N2: 49,        // código subcategoria
  NO_GRP_N2: 50,
  GRP_N3: 51,        // código categoria detalhada
  NO_GRP_N3: 52,
  VL_ATV: 59,        // ValorTotalAtv (PL de referência da linha)
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Mapeamento GrpN2 → seção XML em posicao_carteira
// ────────────────────────────────────────────────────────────────────────────
function mapGrpN2ToXmlSection(grpN2: string): string | null {
  const code = parseInt(grpN2 || "0", 10);
  if (code >= 10100 && code <= 10199) return "caixa";
  if (code >= 10200 && code <= 10299) return "titpublico";
  if (code >= 10300 && code <= 10399) return "titprivado";
  if (code >= 10400 && code <= 10499) return "cotas";
  if (code >= 10500 && code <= 10599) return "titprivado"; // Finvest: Títulos Privados Baixo Risco (CRI, LCI, LIG)
  if (code >= 10600 && code <= 10799) return "participacoes";
  if (code >= 10800 && code <= 10899) return "imoveis";
  if (code >= 19000 && code <= 19999) return "provisao";
  if (code >= 22000 && code <= 22999) return "despesas";
  if (code >= 23000 && code <= 23999) return "provisao";
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Nível de granularidade do item
//   analitico → item específico e identificável (CF XXXXX, CNPJ extraível)
//   generico  → nome contém "Outros", "Diversos" ou código de catch-all
//   agregado  → identificado mas sem detalhe individual
// ────────────────────────────────────────────────────────────────────────────
function determinarNivel(
  codigoAtivo: string,
  grpN3Nome: string,
): "analitico" | "agregado" | "generico" {
  if (/^CF\s+\d+/.test(codigoAtivo)) return "analitico";

  const nomeLower = (grpN3Nome || "").toLowerCase();
  if (
    nomeLower.includes("outros") ||
    nomeLower.includes("diversos") ||
    nomeLower.endsWith("s demais")
  ) {
    return "generico";
  }

  // GrpN3 de catch-all (últimos dois dígitos = 99)
  const n3 = parseInt(grpN3Nome || "0", 10);
  if (!isNaN(n3) && n3 % 100 === 99) return "generico";

  if (grpN3Nome && grpN3Nome.trim().length > 0) return "analitico";
  return "agregado";
}

// ────────────────────────────────────────────────────────────────────────────
// Extrai CNPJ do ativo quando o código for "CF XXXXXXXX"
// ────────────────────────────────────────────────────────────────────────────
function extrairCnpjAtivo(codigoAtivo: string): string | null {
  const m = codigoAtivo?.trim().match(/^CF\s+(\d+)/);
  return m ? m[1] : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Parsers numérico e de data no formato brasileiro
// ────────────────────────────────────────────────────────────────────────────
function parseNum(s: string | undefined): number | null {
  if (!s || s.trim() === "" || s.trim() === "-") return null;
  const v = parseFloat(s.trim().replace(/\./g, "").replace(",", "."));
  return isNaN(v) ? null : v;
}

function parseDateBR(s: string | undefined): string | null {
  if (!s || s.trim() === "") return null;
  const parts = s.trim().split("/");
  if (parts.length !== 3) return null;
  return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Decodifica texto latin-1 a partir de ArrayBuffer
// ────────────────────────────────────────────────────────────────────────────
function decodeLatin1(buffer: ArrayBuffer): string {
  return new TextDecoder("latin1").decode(buffer);
}

// ────────────────────────────────────────────────────────────────────────────
// Tipos internos
// ────────────────────────────────────────────────────────────────────────────
interface RawRow {
  fundo_cnpj: string;
  fundo_nome: string;
  data_posicao: string;   // YYYY-MM-DD
  codigo_ativo: string;
  nome_ativo: string;
  especificacao: string | null;
  quantidade: number | null;
  pu_custo: number | null;
  valor_custo: number | null;
  pu_mercado: number | null;
  valor_mercado: number | null;
  data_vencimento: string | null;
  valor_total_ativo: number | null;
  grp_n1_codigo: string | null;
  grp_n1_nome: string | null;
  grp_n2_codigo: string | null;
  grp_n2_nome: string | null;
  grp_n3_codigo: string | null;
  grp_n3_nome: string | null;
  moeda: string | null;
  administrador: string | null;
  tipo_fundo: string | null;
  seq_linha: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Parseia o CSV Finvest
// ────────────────────────────────────────────────────────────────────────────
function parseFinvestCSV(content: string): { rows: RawRow[]; errors: string[] } {
  const lines = content.split(/\r?\n/);
  const rows: RawRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = line.split(";");

    // Somente linhas de dado do layout LayCrtDia
    if (cols[COL.LAYOUT]?.trim() !== "LayCrtDia") continue;
    if (cols[COL.TYPE]?.trim() !== "V") continue;

    const titulo = cols[COL.TITULO]?.trim() || "";

    // Filtra linhas de PL, CDI e código vazio
    if (!titulo || titulo === "PATLIQ" || titulo === "CDI") continue;

    const dataStr = parseDateBR(cols[COL.DATA]);
    if (!dataStr) {
      errors.push(`Linha ${i + 1}: data inválida "${cols[COL.DATA]}"`);
      continue;
    }

    const fundoCnpj = cols[COL.FUNDO_CNPJ]?.trim() || "";
    if (!fundoCnpj) {
      errors.push(`Linha ${i + 1}: CNPJ do fundo vazio`);
      continue;
    }

    rows.push({
      fundo_cnpj: fundoCnpj,
      fundo_nome: (cols[COL.FUNDO_NOME]?.trim() || "").replace(/\s+/g, " "),
      data_posicao: dataStr,
      codigo_ativo: titulo,
      nome_ativo: (cols[COL.NOME]?.trim() || "").replace(/\s+/g, " "),
      especificacao: cols[COL.ESPEC]?.trim() || null,
      quantidade: parseNum(cols[COL.QT_DISP]),
      pu_custo: parseNum(cols[COL.PU_CST]),
      valor_custo: parseNum(cols[COL.VL_CST]),
      pu_mercado: parseNum(cols[COL.PU_MRC]),
      valor_mercado: parseNum(cols[COL.VL_MRC]),
      data_vencimento: parseDateBR(cols[COL.DATA_VENC]),
      valor_total_ativo: parseNum(cols[COL.VL_ATV]),
      grp_n1_codigo: cols[COL.GRP_N1]?.trim() || null,
      grp_n1_nome: (cols[COL.NO_GRP_N1]?.trim() || "").replace(/\s+/g, " ") || null,
      grp_n2_codigo: cols[COL.GRP_N2]?.trim() || null,
      grp_n2_nome: (cols[COL.NO_GRP_N2]?.trim() || "").replace(/\s+/g, " ") || null,
      grp_n3_codigo: cols[COL.GRP_N3]?.trim() || null,
      grp_n3_nome: (cols[COL.NO_GRP_N3]?.trim() || "").replace(/\s+/g, " ") || null,
      moeda: cols[COL.MOEDA]?.trim() || null,
      administrador: (cols[COL.ADMINISTRADOR]?.trim() || "").replace(/\s+/g, " ") || null,
      tipo_fundo: (cols[COL.TIPO_FUNDO]?.trim() || "").replace(/\s+/g, " ") || null,
      seq_linha: i + 1,
    });
  }

  return { rows, errors };
}

// ────────────────────────────────────────────────────────────────────────────
// Determina status_consolidacao cruzando com dados XML
//   xmlSections: Set das seções (section) encontradas para este fundo/data
//   xmlValorPorSection: mapa section → valor_total para comparação
// ────────────────────────────────────────────────────────────────────────────
function determinarStatusConsolidacao(
  row: RawRow,
  secaoXml: string | null,
  xmlSections: Set<string>,
  xmlValorPorSection: Map<string, number>,
): string {
  if (!secaoXml || !xmlSections.has(secaoXml)) return "somente_csv";

  const xmlValor = xmlValorPorSection.get(secaoXml) ?? 0;
  const csvValor = row.valor_mercado ?? 0;

  // Flag de revisão: divergência material >5% para itens com valor significativo
  if (xmlValor > 0 && csvValor > 0) {
    const diff = Math.abs(xmlValor - csvValor) / Math.max(xmlValor, csvValor);
    if (diff > 0.05) return "flag_revisao";
  }

  // CSV traz classificação mais analítica que o XML pode trazer para itens genéricos
  const nivel = determinarNivel(row.codigo_ativo, row.grp_n3_nome || "");
  if (nivel === "analitico") return "refinado_csv";

  return "ok";
}

// ────────────────────────────────────────────────────────────────────────────
// Handler principal
// ────────────────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Lê o arquivo enviado como multipart/form-data ──────────────────────
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return new Response(
        JSON.stringify({ error: "Envie o arquivo via multipart/form-data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file) {
      return new Response(
        JSON.stringify({ error: "Campo 'file' obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Decodifica latin-1 ─────────────────────────────────────────────────
    const buffer = await file.arrayBuffer();
    const content = decodeLatin1(buffer);

    // ── Parseia o CSV ──────────────────────────────────────────────────────
    const { rows, errors: parseErrors } = parseFinvestCSV(content);

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({
          error: "Nenhuma linha válida encontrada no CSV",
          parse_errors: parseErrors.slice(0, 10),
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Detecta data_posicao e fundos ──────────────────────────────────────
    const dataPosicao = rows[0].data_posicao;
    const fundosSet = new Set(rows.map((r) => r.fundo_cnpj));
    const fundosNomesSet = new Set(rows.map((r) => r.fundo_nome).filter(Boolean));

    // ── Cria registro de importação ────────────────────────────────────────
    const { data: importRec, error: importErr } = await supabase
      .from("importacoes_carteira_finvest")
      .insert({
        file_name: file.name,
        data_posicao: dataPosicao,
        status: "pending",
        total_rows: rows.length,
        fundos_cnpj: [...fundosSet],
        fundos_nomes: [...fundosNomesSet],
      })
      .select("id")
      .single();

    if (importErr || !importRec) {
      throw new Error(`Erro ao criar importação: ${importErr?.message}`);
    }
    const importId = importRec.id as string;

    // ── Remove dados anteriores do mesmo import (re-upload) ────────────────
    // Remove por fundo_cnpj + data_posicao para que cada upload seja idempotente
    await supabase
      .from("carteira_finvest_raw")
      .delete()
      .in("fundo_cnpj", [...fundosSet])
      .eq("data_posicao", dataPosicao);

    await supabase
      .from("posicao_consolidada")
      .delete()
      .in("fundo_cnpj", [...fundosSet])
      .eq("data_posicao", dataPosicao);

    // ── Grava linhas brutas ────────────────────────────────────────────────
    const rawPayload = rows.map((r) => ({ ...r, import_id: importId }));

    const BATCH = 200;
    let importedRaw = 0;
    for (let i = 0; i < rawPayload.length; i += BATCH) {
      const chunk = rawPayload.slice(i, i + BATCH);
      const { error: rawErr } = await supabase
        .from("carteira_finvest_raw")
        .insert(chunk);
      if (rawErr) {
        console.error("Erro ao gravar carteira_finvest_raw:", rawErr.message);
      } else {
        importedRaw += chunk.length;
      }
    }

    // ── Busca IDs das linhas gravadas (para rastrear raw_id) ───────────────
    const { data: rawInserted } = await supabase
      .from("carteira_finvest_raw")
      .select("id, fundo_cnpj, data_posicao, codigo_ativo, grp_n3_codigo, seq_linha")
      .eq("import_id", importId);

    const rawIdMap = new Map<string, string>();
    for (const r of rawInserted ?? []) {
      const key = `${r.fundo_cnpj}|${r.codigo_ativo}|${r.grp_n3_codigo ?? ""}|${r.seq_linha}`;
      rawIdMap.set(key, r.id);
    }

    // ── Consulta dados XML (posicao_carteira) para consolidação ───────────
    // Busca todas as seções disponíveis para os fundos/data do CSV
    const fundosCnpjArray = [...fundosSet];

    // posicao_carteira armazena CNPJ sem formatação (8 a 14 dígitos)
    // Busca por LIKE para cobrir formatos diferentes
    let xmlData: Array<{
      fundo_cnpj: string;
      section: string;
      valorfindisp: number | null;
    }> = [];

    for (const cnpj8 of fundosCnpjArray) {
      const { data: xmlRows } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, section, valorfindisp")
        .ilike("fundo_cnpj", `%${cnpj8}%`)
        .eq("fundo_dtposicao", dataPosicao);

      if (xmlRows) xmlData = xmlData.concat(xmlRows);
    }

    // Agrega por (fundo_cnpj limpo, section) → soma de valor
    const xmlSectionMap = new Map<string, { sections: Set<string>; valoresPorSection: Map<string, number>; cnpjExato: string }>();

    for (const xr of xmlData) {
      // Extrai os 8 primeiros dígitos numéricos do CNPJ XML para cruzar com o CSV
      const cnpjLimpo = xr.fundo_cnpj.replace(/\D/g, "");
      const cnpj8match = fundosCnpjArray.find((c) => cnpjLimpo.includes(c)) ?? cnpjLimpo.slice(0, 8);

      if (!xmlSectionMap.has(cnpj8match)) {
        xmlSectionMap.set(cnpj8match, {
          sections: new Set(),
          valoresPorSection: new Map(),
          cnpjExato: xr.fundo_cnpj,
        });
      }
      const entry = xmlSectionMap.get(cnpj8match)!;
      entry.sections.add(xr.section);
      const v = (entry.valoresPorSection.get(xr.section) ?? 0) + (xr.valorfindisp ?? 0);
      entry.valoresPorSection.set(xr.section, v);
    }

    // ── Monta posicao_consolidada ──────────────────────────────────────────
    let consolidados = 0;
    let flagsRevisao = 0;

    const consolidadoPayload: object[] = [];

    for (const row of rows) {
      const secaoXml = mapGrpN2ToXmlSection(row.grp_n2_codigo ?? "");
      const nivel = determinarNivel(row.codigo_ativo, row.grp_n3_nome ?? "");
      const cnpjAtivo = extrairCnpjAtivo(row.codigo_ativo);

      const xmlEntry = xmlSectionMap.get(row.fundo_cnpj);
      const xmlSections = xmlEntry?.sections ?? new Set<string>();
      const xmlValoresPorSection = xmlEntry?.valoresPorSection ?? new Map<string, number>();

      const statusConsolidacao = determinarStatusConsolidacao(
        row,
        secaoXml,
        xmlSections,
        xmlValoresPorSection,
      );

      if (statusConsolidacao === "flag_revisao") flagsRevisao++;
      if (statusConsolidacao === "ok" || statusConsolidacao === "refinado_csv") consolidados++;

      const rawKey = `${row.fundo_cnpj}|${row.codigo_ativo}|${row.grp_n3_codigo ?? ""}|${row.seq_linha}`;
      const rawId = rawIdMap.get(rawKey) ?? null;

      consolidadoPayload.push({
        fundo_cnpj: row.fundo_cnpj,
        fundo_nome: row.fundo_nome,
        data_posicao: row.data_posicao,
        codigo_ativo: row.codigo_ativo,
        nome_ativo: row.nome_ativo,
        descricao_original: [row.nome_ativo, row.especificacao].filter(Boolean).join(" — ") || null,
        macro_categoria: row.grp_n1_nome,
        codigo_macro: row.grp_n1_codigo,
        subcategoria: row.grp_n2_nome,
        codigo_subcategoria: row.grp_n2_codigo,
        categoria_detalhada: row.grp_n3_nome,
        codigo_categoria_detalhada: row.grp_n3_codigo,
        nivel_granularidade: nivel,
        fonte_origem: "csv_finvest",
        status_consolidacao: statusConsolidacao,
        secao_xml: secaoXml,
        cnpj_ativo: cnpjAtivo,
        quantidade: row.quantidade,
        pu_custo: row.pu_custo,
        valor_custo: row.valor_custo,
        pu_mercado: row.pu_mercado,
        valor_mercado: row.valor_mercado,
        data_vencimento: row.data_vencimento,
        import_id: importId,
        raw_id: rawId,
        posicao_carteira_fundo_cnpj: xmlEntry?.cnpjExato ?? null,
        posicao_carteira_count: xmlSections.has(secaoXml ?? "") ? 1 : 0,
      });
    }

    for (let i = 0; i < consolidadoPayload.length; i += BATCH) {
      const chunk = consolidadoPayload.slice(i, i + BATCH);
      const { error: consErr } = await supabase
        .from("posicao_consolidada")
        .insert(chunk);
      if (consErr) {
        console.error("Erro ao gravar posicao_consolidada:", consErr.message);
      }
    }

    // ── Atualiza status do import ──────────────────────────────────────────
    const finalStatus = parseErrors.length > 0 ? "partial_success" : "success";
    await supabase
      .from("importacoes_carteira_finvest")
      .update({
        status: finalStatus,
        imported_rows: importedRaw,
        rejected_rows: parseErrors.length,
      })
      .eq("id", importId);

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        data_posicao: dataPosicao,
        fundos_processados: [...fundosNomesSet],
        total_rows: rows.length,
        imported_rows: importedRaw,
        rejected_rows: parseErrors.length,
        consolidados,
        flags_revisao: flagsRevisao,
        somente_csv: rows.length - consolidados - flagsRevisao,
        parse_errors: parseErrors.slice(0, 10),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("import-carteira-finvest:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
