import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync } from "npm:fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CVM_BASE_URL = "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(supabaseUrl, serviceRole);

interface InformeRow {
  fundo_cnpj: string;
  cnpj_origem: string;
  vinculo_identidade: "direto" | "alias";
  data_competencia: string;
  patrimonio_liquido: number | null;
  numero_cotistas: number | null;
  valor_cota: string | null;
  valor_carteira: number | null;
  captacao_dia: number | null;
  resgate_dia: number | null;
  origem: "informe_diario_fi";
  arquivo_origem: string;
}

/** Mantém todas as casas do CSV; fica neste arquivo para deploy pelo SQL Dashboard/Editor de funções. */
function parseCotaDecimal(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  return /^[+-]?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

function normalizarCnpj(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length ? digits.padStart(14, "0").slice(-14) : "";
}

function parseNumero(value: string | null | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const number = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  return Number.isFinite(number) ? number : null;
}

function parseData(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
}

function decode(bytes: Uint8Array): string {
  const utf = new TextDecoder("utf-8").decode(bytes);
  return utf.includes("\uFFFD") ? new TextDecoder("iso-8859-1").decode(bytes) : utf;
}

function parseLinha(linha: string): string[] {
  const out: string[] = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const char = linha[i];
    if (char === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; }
      else aspas = !aspas;
    } else if (char === ";" && !aspas) { out.push(atual); atual = ""; }
    else atual += char;
  }
  out.push(atual);
  return out;
}

function indice(header: string[], ...candidatos: string[]): number {
  const norm = (s: string) => s.trim().toUpperCase().replace(/^\uFEFF/, "");
  const wanted = candidatos.map(norm);
  return header.findIndex((value) => wanted.includes(norm(value)));
}

function valor(row: string[], index: number): string | null {
  return index >= 0 && index < row.length ? row[index] : null;
}

function aceitarCnpj(fundoCnpj: string, cnpjs: Set<string>, raizes: Set<string>): boolean {
  return cnpjs.has(fundoCnpj) || raizes.has(fundoCnpj.slice(0, 8));
}

function dvCnpj(base12: string): string {
  const calc = (nums: number[], pesos: number[]) => {
    const soma = nums.reduce((s, n, i) => s + n * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const n = base12.split("").map(Number);
  const d1 = calc(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc([...n, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}

function cnpjClasseDaRaiz(raiz: string, ordem = "0001"): string {
  const r = raiz.replace(/\D/g, "").padStart(8, "0").slice(-8);
  const o = ordem.replace(/\D/g, "").padStart(4, "0").slice(-4);
  if (r.length !== 8) return "";
  return r + o + dvCnpj(r + o);
}

function campoCsv(linha: string, idx: number): string {
  let atual = 0;
  let start = 0;
  for (let i = 0; i <= linha.length; i++) {
    if (i === linha.length || linha[i] === ";") {
      if (atual === idx) return linha.slice(start, i);
      atual++;
      start = i + 1;
    }
  }
  return "";
}

/** CVM publica um CSV mensal no ZIP; meses antigos podem ter um arquivo por dia. */
function escolherArquivosInformeCvm(nomes: string[]): string[] {
  const base = (path: string) => path.replace(/^.*[/\\]/, "");
  const csvs = nomes.filter((n) => n.toLowerCase().endsWith(".csv"));
  const mensal = csvs.filter((n) => /^inf_diario_fi_\d{6}\.csv$/i.test(base(n)));
  return mensal.length ? mensal : csvs;
}

function validarDataCompetencia(data: string | undefined, competencia: string): string | null {
  if (!data) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error("data_competencia deve usar YYYY-MM-DD.");
  if (data.slice(0, 4) + data.slice(5, 7) !== competencia) {
    throw new Error("data_competencia fora da competência solicitada.");
  }
  return data;
}

function extrairLinhas(
  csv: string,
  cnpjs: Set<string>,
  raizes: Set<string>,
  arquivo: string,
  dataFiltro: string | null = null,
): InformeRow[] {
  const inicio = csv.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const fimHeader = csv.indexOf("\n", inicio);
  if (fimHeader < 0) return [];
  const header = parseLinha(csv.slice(inicio, fimHeader).replace(/\r$/, ""));
  const idxCnpj = indice(header, "CNPJ_FUNDO_CLASSE", "CNPJ_FUNDO");
  const idxData = indice(header, "DT_COMPTC", "DT_COMPETENCIA");
  const idxPl = indice(header, "VL_PATRIM_LIQ", "VL_PATRIMONIO_LIQUIDO");
  const idxCotistas = indice(header, "NR_COTST", "NR_COTISTAS");
  const idxCota = indice(header, "VL_QUOTA", "VL_COTA");
  const idxCarteira = indice(header, "VL_TOTAL", "VL_CARTEIRA");
  const idxCaptacao = indice(header, "CAPTC_DIA", "VL_CAPTACOES");
  const idxResgate = indice(header, "RESG_DIA", "VL_RESGATES");
  if (idxCnpj < 0 || idxData < 0 || idxPl < 0 || idxCotistas < 0) {
    throw new Error("Colunas obrigatórias do Informe Diário não encontradas no arquivo CVM.");
  }

  const out: InformeRow[] = [];
  let start = fimHeader + 1;
  while (start < csv.length) {
    let end = csv.indexOf("\n", start);
    if (end < 0) end = csv.length;
    const linha = csv.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!linha) continue;
    const fundoCnpj = normalizarCnpj(campoCsv(linha, idxCnpj));
    if (!aceitarCnpj(fundoCnpj, cnpjs, raizes)) continue;
    const data = parseData(campoCsv(linha, idxData));
    if (!data || (dataFiltro && data !== dataFiltro)) continue;
    out.push({
      fundo_cnpj: fundoCnpj,
      cnpj_origem: fundoCnpj,
      vinculo_identidade: "direto",
      data_competencia: data,
      patrimonio_liquido: parseNumero(campoCsv(linha, idxPl)),
      numero_cotistas: parseNumero(campoCsv(linha, idxCotistas)),
      valor_cota: parseCotaDecimal(campoCsv(linha, idxCota)),
      valor_carteira: parseNumero(campoCsv(linha, idxCarteira)),
      captacao_dia: parseNumero(campoCsv(linha, idxCaptacao)),
      resgate_dia: parseNumero(campoCsv(linha, idxResgate)),
      origem: "informe_diario_fi",
      arquivo_origem: arquivo,
    });
  }
  return out;
}

function chaveNomeCvm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(FICFIF|FIF|FIC|FIM|FIDC|FII|FIP)\b/g, " ")
    .replace(/FUNDO DE INVESTIMENTO(?: FINANCEIRO)?(?: EM COTAS DE(?: FUNDOS? DE INVESTIMENTO(?: FINANCEIRO)?)?)?/g, " ")
    .replace(/\b(RESPONSABILIDADE LIMITADA|RESP LIMITADA|CREDITO PRIVADO|CRED\.? PRIV\.?|MULTIMERCADO|COTAS)\b/g, " ")
    .replace(/[^A-Z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ligarAlias(aliases: Map<string, Set<string>>, a: string, b: string): void {
  if (!a || !b || a === b) return;
  if (!aliases.has(a)) aliases.set(a, new Set());
  aliases.get(a)!.add(b);
  if (!aliases.has(b)) aliases.set(b, new Set());
  aliases.get(b)!.add(a);
}

async function expandirCnpjsCadastro(solicitados: Set<string>): Promise<{ busca: Set<string>; aliases: Map<string, Set<string>>; nomes: Map<string, string> }> {
  const busca = new Set(solicitados);
  const aliases = new Map<string, Set<string>>();
  const nomes = new Map<string, string>();
  const digits = [...solicitados];
  for (let i = 0; i < digits.length; i += 80) {
    const lote = digits.slice(i, i + 80);
    const consultas = await Promise.all([
      admin.from("fundos_caracteristicas").select("cnpj_classe, cnpj_fundo, nome_comercial").in("cnpj_classe", lote),
      admin.from("fundos_caracteristicas").select("cnpj_classe, cnpj_fundo, nome_comercial").in("cnpj_fundo", lote),
    ]);
    for (const { data } of consultas) {
      for (const row of data ?? []) {
        const classe = normalizarCnpj(row.cnpj_classe as string | null);
        const fundo = normalizarCnpj(row.cnpj_fundo as string | null);
        const nome = String(row.nome_comercial ?? "").trim();
        if (classe) busca.add(classe);
        if (fundo) busca.add(fundo);
        ligarAlias(aliases, classe, fundo);
        if (nome) {
          if (classe) nomes.set(classe, nome);
          if (fundo) nomes.set(fundo, nome);
        }
      }
    }
  }
  return { busca, aliases, nomes };
}

async function expandirCnpjsFinvest(
  busca: Set<string>,
  aliases: Map<string, Set<string>>,
  nomes: Map<string, string>,
  solicitados: Set<string>,
): Promise<{ raizes: Set<string>; porRaiz: Map<string, string[]> }> {
  const raizes = new Set<string>();
  const porRaiz = new Map<string, string[]>();
  const { data } = await admin.from("finvest_fundos").select("codigo, nome").eq("ativo", true);
  const porChave = new Map<string, string[]>();
  for (const row of data ?? []) {
    const raiz = String(row.codigo ?? "").replace(/\D/g, "").padStart(8, "0").slice(-8);
    const chave = chaveNomeCvm(String(row.nome ?? ""));
    if (raiz.length !== 8 || chave.length < 4) continue;
    porChave.set(chave, [...(porChave.get(chave) ?? []), raiz]);
  }
  for (const solicitado of solicitados) {
    const chave = chaveNomeCvm(nomes.get(solicitado) ?? "");
    if (chave.length < 4) continue;
    const exatos = porChave.get(chave) ?? [];
    const encontradas = [...new Set(exatos)];
    if (encontradas.length !== 1) continue;
    const raiz = encontradas[0];
    const cvm = cnpjClasseDaRaiz(raiz);
    if (!cvm) continue;
    busca.add(cvm);
    raizes.add(raiz);
    porRaiz.set(raiz, [...(porRaiz.get(raiz) ?? []), solicitado]);
    ligarAlias(aliases, cvm, solicitado);
  }
  return { raizes, porRaiz };
}

async function expandirCnpjsRegistroCvm(
  busca: Set<string>,
  aliases: Map<string, Set<string>>,
  nomes: Map<string, string>,
  solicitados: Set<string>,
): Promise<void> {
  const resp = await fetch("https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip");
  if (!resp.ok) return;
  const zip = unzipSync(new Uint8Array(await resp.arrayBuffer()));
  const chaveArq = Object.keys(zip).find((n) => /registro_classe\.csv$/i.test(n.split("/").at(-1) ?? n));
  if (!chaveArq) return;
  const csv = decode(zip[chaveArq]);
  const linhas = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) return;
  const header = parseLinha(linhas[0]);
  const idxCnpj = indice(header, "CNPJ_CLASSE", "CNPJ_FUNDO_CLASSE");
  const idxNome = indice(header, "DENOMINACAO_SOCIAL", "DENOM_SOCIAL");
  if (idxCnpj < 0 || idxNome < 0) return;

  const porChave = new Map<string, string[]>();
  for (const linha of linhas.slice(1)) {
    const row = parseLinha(linha);
    const cnpj = normalizarCnpj(valor(row, idxCnpj));
    const chaveNome = chaveNomeCvm(valor(row, idxNome) ?? "");
    if (!cnpj || chaveNome.length < 6) continue;
    const lista = porChave.get(chaveNome) ?? [];
    lista.push(cnpj);
    porChave.set(chaveNome, lista);
  }

  for (const solicitado of solicitados) {
    const nome = nomes.get(solicitado) ?? "";
    const chave = chaveNomeCvm(nome);
    if (chave.length < 6) continue;
    const exatos = porChave.get(chave) ?? [];
    const unicos = [...new Set(exatos)];
    if (unicos.length !== 1) continue;
    busca.add(unicos[0]);
    ligarAlias(aliases, unicos[0], solicitado);
  }
}

function aplicarAliases(rows: InformeRow[], aliases: Map<string, Set<string>>): InformeRow[] {
  if (!aliases.size) return rows;
  const extra: InformeRow[] = [];
  const visto = new Set(rows.map((r) => `${r.fundo_cnpj}|${r.data_competencia}`));
  for (const row of rows) {
    for (const alias of aliases.get(row.fundo_cnpj) ?? []) {
      const id = `${alias}|${row.data_competencia}`;
      if (visto.has(id)) continue;
      visto.add(id);
      extra.push({ ...row, fundo_cnpj: alias, vinculo_identidade: "alias" });
    }
  }
  return extra.length ? [...rows, ...extra] : rows;
}

function competenciaAnterior(yyyymm: string): string {
  const ano = Number(yyyymm.slice(0, 4));
  const mes = Number(yyyymm.slice(4, 6));
  const d = new Date(ano, mes - 2, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** O ZIP do mês corrente na CVM costuma estar incompleto; abaixo disso buscamos o mês anterior. */
const MIN_COBERTURA_FUNDOS = 0.4;

function coberturaFundos(rows: InformeRow[], fundos: Set<string>, raizes: Set<string> = new Set()): number {
  if (!fundos.size) return 1;
  const ok = new Set(rows.map((r) => r.fundo_cnpj));
  const raizesOk = new Set([...ok].map((cnpj) => cnpj.slice(0, 8)));
  let n = 0;
  let denom = 0;
  for (const cnpj of fundos) {
    if (ok.has(cnpj) || raizesOk.has(cnpj.slice(0, 8))) {
      n++;
      denom++;
      continue;
    }
    if (raizes.size && !raizes.has(cnpj.slice(0, 8))) continue;
    denom++;
  }
  if (!denom) return raizesOk.size ? 1 : 0;
  return n / denom;
}

async function baixarInformeCvm(
  competenciaInicial: string,
  fundos: Set<string>,
  raizes: Set<string>,
  estrito = false,
  dataFiltro: string | null = null,
): Promise<{
  rows: InformeRow[];
  competencia: string;
  url: string;
  tentativas: string[];
}> {
  const tentativas: string[] = [];
  const allRows: InformeRow[] = [];
  let competencia = competenciaInicial;
  let competenciaPrincipal = competenciaInicial;
  let urlPrincipal = "";
  let melhorCobertura = -1;
  let algumZip = false;

  for (let i = 0; i < (estrito ? 1 : 4); i++) {
    tentativas.push(competencia);
    const url = `${CVM_BASE_URL}/inf_diario_fi_${competencia}.zip`;
    const resposta = await fetch(url);
    if (resposta.ok) {
      algumZip = true;
      const entries = unzipSync(new Uint8Array(await resposta.arrayBuffer()));
      const arquivos = escolherArquivosInformeCvm(Object.keys(entries));
      if (!arquivos.length) throw new Error("ZIP CVM não contém CSV elegível.");
      const rows = arquivos.flatMap((arquivo) => extrairLinhas(decode(entries[arquivo]), fundos, raizes, arquivo, dataFiltro));
      if (rows.length) allRows.push(...rows);
      const cob = coberturaFundos(allRows, fundos, raizes);
      if (cob >= melhorCobertura) {
        melhorCobertura = cob;
        competenciaPrincipal = competencia;
        urlPrincipal = url;
      }
      if (cob >= MIN_COBERTURA_FUNDOS) {
        return { rows: allRows, competencia: competenciaPrincipal, url: urlPrincipal, tentativas };
      }
    } else if (resposta.status !== 404) {
      throw new Error(`Arquivo CVM indisponível para ${competencia}: HTTP ${resposta.status}.`);
    }
    competencia = competenciaAnterior(competencia);
  }
  if (!algumZip) {
    throw new Error(
      `Informe Diário CVM não publicado nas competências consultadas (${tentativas.join(", ")}). ` +
      "Use uma data de referência anterior ou aguarde a publicação na CVM.",
    );
  }
  return { rows: allRows, competencia: competenciaPrincipal, url: urlPrincipal, tentativas };
}

async function apagarMetricasAliasCopiadas(reais: InformeRow[], solicitados: Set<string>, gravados: InformeRow[]): Promise<void> {
  const manter = new Set([...reais, ...gravados].map((r) => r.fundo_cnpj));
  const fp = new Set(reais.map((r) => `${r.data_competencia}|${r.patrimonio_liquido}|${r.numero_cotistas}`));
  const candidatos = [...solicitados].filter((cnpj) => !manter.has(cnpj));
  for (let i = 0; i < candidatos.length; i += 50) {
    const lote = candidatos.slice(i, i + 50);
    const { data, error } = await admin.from("informe_diario_metricas")
      .select("id, data_competencia, patrimonio_liquido, numero_cotistas")
      .in("fundo_cnpj", lote)
      .eq("origem", "informe_diario_fi");
    if (error || !data?.length) continue;
    const ids = data
      .filter((row) => fp.has(`${row.data_competencia}|${row.patrimonio_liquido}|${row.numero_cotistas}`))
      .map((row) => row.id as string);
    if (ids.length) await admin.from("informe_diario_metricas").delete().in("id", ids);
  }
}

async function upsertEmLotes(rows: InformeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("informe_diario_metricas").upsert(rows.slice(i, i + 500).map((row) => ({ ...row, carregado_em: new Date().toISOString() })), {
      onConflict: "fundo_cnpj,data_competencia,origem",
    });
    if (error) {
      if (error.message.includes("Could not find the table") || error.code === "42P01") {
        throw new Error("Tabela informe_diario_metricas não existe. Aplique a migration 20260908090000_create_informe_diario_metricas.sql no Supabase.");
      }
      throw new Error(`Falha ao gravar lote ${i / 500 + 1}: ${error.message}`);
    }
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json() as { competencia?: string; fundos?: string[]; nomes?: Record<string, string>; conciliacao_estrita?: boolean; data_competencia?: string };
    const competenciaSolicitada = body.competencia ?? new Date().toISOString().slice(0, 7).replace("-", "");
    if (!/^\d{6}$/.test(competenciaSolicitada)) throw new Error("Competência deve usar o formato YYYYMM.");
    const fundos = new Set((body.fundos ?? []).map(normalizarCnpj).filter((cnpj) => cnpj.length === 14));
    if (!fundos.size) throw new Error("Informe ao menos um CNPJ de fundo para importar.");
    if (fundos.size > 500) throw new Error("Limite de 500 fundos por importação.");
    const dataFiltro = validarDataCompetencia(body.data_competencia, competenciaSolicitada);

    // Conciliação: somente identidade literal, competência e data solicitadas.
    // Não reutiliza associações heurísticas nem procura cota de outro mês.
    if (body.conciliacao_estrita === true) {
      const { rows, url } = await baixarInformeCvm(competenciaSolicitada, fundos, new Set(), true, dataFiltro);
      await upsertEmLotes(rows);
      return new Response(JSON.stringify({ success: true, registros_importados: rows.length, arquivo: url,
        competencia: competenciaSolicitada }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { busca, aliases, nomes } = await expandirCnpjsCadastro(fundos);
    for (const [cnpj, nome] of Object.entries(body.nomes ?? {})) {
      const id = normalizarCnpj(cnpj);
      if (id.length === 14 && nome.trim()) nomes.set(id, nome.trim());
    }
    let raizes = new Set<string>();
    try {
      raizes = (await expandirCnpjsFinvest(busca, aliases, nomes, fundos)).raizes;
    } catch {
      /* catálogo Finvest é complemento */
    }
    try {
      await expandirCnpjsRegistroCvm(busca, aliases, nomes, fundos);
    } catch {
      /* cadastro CVM é complemento; a carga segue com os CNPJs já conhecidos */
    }

    const { rows, competencia: competenciaUsada, url, tentativas } = await baixarInformeCvm(competenciaSolicitada, busca, raizes);
    const gravar = aplicarAliases(rows, aliases);
    await upsertEmLotes(gravar);
    await apagarMetricasAliasCopiadas(rows, fundos, gravar);
    return new Response(JSON.stringify({
      success: true,
      competencia: competenciaUsada,
      competencia_solicitada: competenciaSolicitada,
      competencias_tentadas: tentativas,
      fundos_solicitados: fundos.size,
      fundos_buscados: busca.size,
      registros_importados: gravar.length,
      arquivo: url,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
