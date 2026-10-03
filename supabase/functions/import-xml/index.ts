import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { XMLParser } from 'https://esm.sh/fast-xml-parser@4.3.2';
import { crypto } from 'https://deno.land/std@0.168.0/crypto/mod.ts';
import { buildNaturalKeySeed } from './naturalKey.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Colunas numéricas para conversão
const NUMERIC_COLS = new Set([
  'fundo_valorativos', 'fundo_patliq', 'fundo_valorreceber', 'fundo_valorpagar',
  'fundo_vlcotasemitir', 'fundo_vlcotasresgatar', 'fundo_valorcota', 'fundo_quantidade',
  'qtdisponivel', 'qtgarantia', 'valorfindisp', 'valorfinemgar', 'tributos', 'puposicao',
  'percprovcred', 'txalug', 'saldo', 'pucompra', 'puvencimento', 'puemissao', 'principal',
  'percindex', 'valor', 'txadm', 'perctaxaadm', 'vltxperf', 'perctxperf', 'outtax',
  'valorfinanceiro', 'percpart', 'valorcontabil', 'valoravaliacao', 'aluguelcontratado',
  'aluguelatrasado', 'compromisso_puretorno', 'compromisso_perindexcomp',
  'compromisso_txoperacao', 'coupom'
]);

// Lista de todas as colunas possíveis da tabela
const ALL_TABLE_COLUMNS = [
  'natural_key', 'arquivo_nome', 'section', 'possui_compromisso',
  'fundo_isin', 'fundo_cnpj', 'fundo_nome', 'nome_fundo', 'fundo_dtposicao',
  'fundo_nomeadm', 'fundo_cnpjadm', 'fundo_nomegestor', 'fundo_cnpjgestor',
  'fundo_nomecustodiante', 'fundo_cnpjcustodiante', 'fundo_valorcota',
  'fundo_quantidade', 'fundo_patliq', 'fundo_valorativos', 'fundo_valorreceber',
  'fundo_valorpagar', 'fundo_vlcotasemitir', 'fundo_vlcotasresgatar',
  'fundo_codanbid', 'fundo_tipofundo', 'fundo_nivelrsc',
  'isin', 'codativo', 'cusip', 'cnpjfundo', 'cnpjemissor', 'cnpjpart', 'idinternoativo',
  'dtemissao', 'dtoperacao', 'dtvencimento', 'qtdisponivel', 'qtgarantia',
  'pucompra', 'puposicao', 'puvencimento', 'puemissao', 'principal',
  'valorfindisp', 'valorfinemgar', 'tributos', 'valorfinanceiro',
  'indexador', 'percindex', 'coupom', 'caracteristica', 'classeoperacao',
  'depgar', 'percprovcred', 'nivelrsc', 'compromisso_dtretorno',
  'compromisso_puretorno', 'compromisso_indexadorcomp', 'compromisso_perindexcomp',
  'compromisso_txoperacao', 'compromisso_classecomp', 'isininstituicao',
  'tpconta', 'saldo', 'txadm', 'perctaxaadm', 'txperf', 'vltxperf',
  'perctxperf', 'outtax', 'codprov', 'credeb', 'dt', 'valor', 'nivel1_categoria',
  'valor_padrao',
  'logradouro', 'numero', 'complemento', 'cidade', 'estado', 'cep',
  'nomecomercial', 'percpart', 'valorcontabil', 'justificativa',
  'valoravaliacao', 'tpavaliador', 'cnpjcpfavaliador', 'aluguelcontratado',
  'aluguelatrasado', 'opcaorecompra', 'dtopcaorecompra', 'tipoimovel',
  'questjur', 'motivoquestjur', 'tipouso', 'matricula', 'cnpjemp',
  'ativo_id'
];

interface AtivoData {
  tipo_ativo: string;
  descricao: string | null;
  nome_frontend?: string | null;
  isin: string | null;
  cnpj: string | null;
  ticker: string | null;
  codigo_cetip_selic: string | null;
  matricula_imovel: string | null;
  endereco_imovel: string | null;
}

// Cache local para ativos (identifier -> id)
const ativosCache: Map<string, string> = new Map();

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCnpj(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 14 ? digits : null;
}

function normalizeIsin(value: unknown): string | null {
  const raw = normalizeText(value);
  return raw ? raw.toUpperCase() : null;
}

function isInvalidIsin(isin: string | null | undefined): boolean {
  if (!isin) return true;
  const u = isin.trim().toUpperCase();
  if (u.includes('*')) return true;
  if (/^[A-Z]{2}0+$/.test(u)) return true; // BR0000000000, XX000000000000
  return false;
}

function tokenSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, '').trim();
  const ta = new Set(norm(a).split(/\s+/).filter(Boolean));
  const tb = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function toNumeric(value: any): number | null {
  if (value === null || value === undefined || value === '' || value === '00000000') return null;
  if (typeof value === 'number') return value;
  try {
    return parseFloat(String(value).replace(',', '.'));
  } catch {
    return null;
  }
}

function cleanRecord(record: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '' || value === '00000000') {
      cleaned[key] = null;
    } else if (NUMERIC_COLS.has(key)) {
      cleaned[key] = toNumeric(value as string);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function getValorPadrao(record: Record<string, unknown>, section: string): number | null {
  if (section === 'participacoes' || section === 'fidc') return toNumeric(record['valorfinanceiro'] as string);
  if (section === 'provisao') return toNumeric(record['valor'] as string);
  if (section === 'caixa') return toNumeric(record['saldo'] as string);
  if (section === 'imoveis') return toNumeric(record['valorcontabil'] as string);
  if (['cotas', 'titpublico', 'titprivado', 'termorf', 'acoes'].includes(section)) {
    return toNumeric(record['valorfindisp'] as string);
  }
  return null;
}

async function md5Hash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('MD5', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractAtivoData(record: Record<string, unknown>): AtivoData {
  const section = record['section'] as string;
  const ativo: AtivoData = {
    tipo_ativo: section?.toUpperCase() || 'OUTROS',
    descricao: null,
    isin: normalizeIsin(record['isin']),
    cnpj: null,
    ticker: normalizeText(record['codativo']),
    codigo_cetip_selic: null,
    matricula_imovel: normalizeText(record['matricula']),
    endereco_imovel: null
  };

  if (section === 'cotas') {
    ativo.tipo_ativo = 'FUNDO';
    ativo.cnpj = normalizeCnpj(record['cnpjfundo']) || normalizeCnpj(record['cnpjemissor']) || normalizeCnpj(record['cnpjpart']);
    ativo.descricao = firstNonEmpty(
      record['nomecomercial'],
      record['nomeativo'],
      record['nome'],
      record['denominacao'],
      record['denominacaosocial']
    );
  } else if (section === 'acoes') {
    ativo.tipo_ativo = 'ACAO';
    ativo.descricao = firstNonEmpty(record['codativo'], record['isin']) || 'ACAO SEM NOME';
  } else if (section === 'titpublico') {
    ativo.tipo_ativo = 'TITULO_PUBLICO';
    ativo.codigo_cetip_selic = normalizeText(record['codativo']);
    ativo.descricao = firstNonEmpty(record['codativo']) || 'TITULO PUBLICO';
  } else if (section === 'titprivado') {
    ativo.tipo_ativo = 'TITULO_PRIVADO';
    ativo.cnpj = normalizeCnpj(record['cnpjemissor']);
    ativo.codigo_cetip_selic = normalizeText(record['codativo']);
    ativo.descricao = firstNonEmpty(
      [normalizeText(record['codativo']), normalizeText(record['cnpjemissor'])].filter(Boolean).join(' - '),
      record['codativo'],
      record['cnpjemissor']
    );
  } else if (section === 'termorf') {
    ativo.tipo_ativo = 'TERMORF';
    ativo.cnpj = normalizeCnpj(record['cnpjemissor']);
    ativo.codigo_cetip_selic = normalizeText(record['codativo']);
    ativo.descricao = firstNonEmpty(
      [normalizeText(record['codativo']), normalizeText(record['cnpjemissor'])].filter(Boolean).join(' - '),
      record['codativo'],
      record['cnpjemissor']
    ) || 'TERMO RF';
  } else if (section === 'imoveis') {
    ativo.tipo_ativo = 'IMOVEL';
    ativo.cnpj = normalizeCnpj(record['cnpjemp']);
    ativo.descricao = firstNonEmpty(record['nomecomercial']) || 'IMOVEL';
    const parts = ['logradouro', 'numero', 'cidade', 'estado']
      .map(k => normalizeText(record[k]))
      .filter(Boolean);
    if (parts.length > 0) {
      ativo.endereco_imovel = parts.join(', ');
    }
  } else if (section === 'participacoes') {
    ativo.tipo_ativo = 'PARTICIPACAO';
    ativo.cnpj = normalizeCnpj(record['cnpjpart']) || normalizeCnpj(record['cnpjemissor']);
    ativo.descricao = firstNonEmpty(record['nomecomercial']) || (ativo.cnpj ? `PARTICIPACAO CNPJ ${ativo.cnpj}` : 'PARTICIPACAO');
  } else if (section === 'caixa') {
    ativo.tipo_ativo = 'CAIXA';
    ativo.isin = normalizeIsin(record['isininstituicao']);
    ativo.descricao = `CAIXA - ${normalizeText(record['isininstituicao']) || ''}`;
  } else if (section === 'fidc') {
    ativo.tipo_ativo = 'FIDC';
    ativo.cnpj = normalizeCnpj(record['cnpjemissor']) || normalizeCnpj(record['cnpjfundo']);
    ativo.descricao = firstNonEmpty(record['nomecomercial']) || `FIDC - ${normalizeText(record['cnpjemissor']) || ''}`;
  }

  return ativo;
}

async function getAtivoIdentifier(ativo: AtivoData): Promise<string> {
  const tipo = ativo.tipo_ativo;

  if (tipo === 'IMOVEL') {
    if (ativo.matricula_imovel) return `MAT:${ativo.matricula_imovel}`;
    if (ativo.endereco_imovel) return `END:${await md5Hash(ativo.endereco_imovel)}`;
    return `DESC:${await md5Hash(ativo.descricao || '')}`;
  }

  // Fundos com ISIN válido: uma linha por classe (CNPJ compartilhado entre séries)
  if ((tipo === 'FUNDO' || tipo === 'FIDC') && ativo.isin && !ativo.isin.includes('*')) {
    return `ISIN:${ativo.isin}`;
  }

  // Prioriza CNPJ sobre ISIN mascarado (BR**********)
  if (ativo.cnpj) return `CNPJ:${ativo.cnpj}`;
  if (ativo.isin && !ativo.isin.includes('*')) return `ISIN:${ativo.isin}`;
  if (ativo.ticker) return `TICKER:${ativo.ticker}`;
  if (ativo.codigo_cetip_selic) return `COD:${ativo.codigo_cetip_selic}`;
  if (ativo.matricula_imovel) return `MAT:${ativo.matricula_imovel}`;
  if (ativo.endereco_imovel) return `END:${await md5Hash(ativo.endereco_imovel)}`;
  return `DESC:${await md5Hash(ativo.descricao || '')}`;
}

// Cache local para nomes de fundos (CNPJ -> nome)
const fundNamesCache: Map<string, string> = new Map();

async function getFundNameFromRegistry(cnpj: string): Promise<string | null> {
  if (fundNamesCache.has(cnpj)) return fundNamesCache.get(cnpj)!;

  // Converte CNPJ string para número para bater com as tabelas de registro
  const cnpjNum = parseInt(cnpj.replace(/\D/g, ''));
  
  try {
    // Tenta primeiro em registro_fundo
    const { data: fundo } = await supabase
      .from('registro_fundo')
      .select('denominacao_social')
      .eq('cnpj_fundo', cnpjNum)
      .limit(1)
      .maybeSingle();
      
    if (fundo?.denominacao_social) {
      fundNamesCache.set(cnpj, fundo.denominacao_social);
      return fundo.denominacao_social;
    }
    
    // Tenta em registro_classe
    const { data: classe } = await supabase
      .from('registro_classe')
      .select('denominacao_social')
      .eq('cnpj_classe', cnpjNum)
      .limit(1)
      .maybeSingle();
      
    if (classe?.denominacao_social) {
      fundNamesCache.set(cnpj, classe.denominacao_social);
      return classe.denominacao_social;
    }
  } catch (error) {
    console.error(`Erro ao buscar nome do fundo ${cnpj}:`, error);
  }
    
  return null;
}

const fundCaractCache: Map<string, string> = new Map();

async function getFundNameFromCaracteristicas(
  cnpj: string | null,
  isin: string | null,
): Promise<string | null> {
  if (!isin || isin.includes('*')) return null;

  const cacheKey = `${cnpj || ''}|${isin}`;
  if (fundCaractCache.has(cacheKey)) return fundCaractCache.get(cacheKey)!;

  try {
    let query = supabase
      .from('fundos_caracteristicas')
      .select('nome_comercial')
      .eq('isin', isin)
      .limit(1);

    if (cnpj) {
      query = query.or(`cnpj_classe.eq.${cnpj},cnpj_fundo.eq.${cnpj}`);
    }

    const { data } = await query.maybeSingle();
    const nome = data?.nome_comercial?.trim() || null;
    if (nome) fundCaractCache.set(cacheKey, nome);
    return nome;
  } catch (error) {
    console.error(`Erro ao buscar nome ANBIMA ${isin}:`, error);
    return null;
  }
}

async function resolveFundoDescricao(data: AtivoData): Promise<string | null> {
  const fromAnbima = await getFundNameFromCaracteristicas(data.cnpj, data.isin);
  if (fromAnbima) return fromAnbima;
  if (data.descricao?.trim()) return data.descricao.trim();
  if (data.cnpj) return (await getFundNameFromRegistry(data.cnpj)) || `${data.tipo_ativo} CNPJ ${data.cnpj}`;
  return data.descricao;
}

interface SyncAtivosResult {
  newAssets: AtivoData[];
  errors: string[];
}

async function syncAtivos(records: Record<string, unknown>[]): Promise<SyncAtivosResult> {
  const result: SyncAtivosResult = { newAssets: [], errors: [] };
  const ativosToCreate: Array<{ identifier: string; data: AtivoData }> = [];
  const identifiersMap: Map<string, number[]> = new Map();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const section = normalizeText(record['section'])?.toLowerCase();

    if (!section || ['despesas', 'provisao'].includes(section)) {
      continue;
    }

    const ativoData = extractAtivoData(record);
    const identifier = await getAtivoIdentifier(ativoData);

    if (ativosCache.has(identifier)) {
      record['ativo_id'] = ativosCache.get(identifier);
      continue;
    }

    if (!identifiersMap.has(identifier)) {
      identifiersMap.set(identifier, []);
      ativosToCreate.push({ identifier, data: ativoData });
    }

    identifiersMap.get(identifier)!.push(i);
  }

  if (ativosToCreate.length === 0) return result;

  for (const { identifier, data } of ativosToCreate) {
    let existingId: string | null = null;
    let isNew = false;

    // Tenta buscar ativo existente — prioriza CNPJ sobre ISIN mascarado
    if (data.tipo_ativo === 'IMOVEL' && data.matricula_imovel) {
      const { data: existing } = await supabase
        .from('ativos')
        .select('id, descricao')
        .eq('matricula_imovel', data.matricula_imovel)
        .limit(1)
        .maybeSingle();
      existingId = existing?.id || null;
      if (existingId && !existing.descricao && data.descricao) {
        await supabase.from('ativos').update({ descricao: data.descricao }).eq('id', existingId);
      }
    } else if (
      (data.tipo_ativo === 'FUNDO' || data.tipo_ativo === 'FIDC') &&
      data.isin &&
      !data.isin.includes('*')
    ) {
      const { data: existing } = await supabase
        .from('ativos')
        .select('id, descricao')
        .eq('isin', data.isin)
        .eq('tipo_ativo', data.tipo_ativo)
        .limit(1)
        .maybeSingle();
      existingId = existing?.id || null;

      if (existingId) {
        const resolvedDesc = await resolveFundoDescricao(data);
        if (resolvedDesc && resolvedDesc !== (existing.descricao || '')) {
          await supabase.from('ativos').update({ descricao: resolvedDesc }).eq('id', existingId);
        }
      }
    } else if (data.cnpj) {
      const { data: existing } = await supabase
        .from('ativos')
        .select('id, descricao')
        .eq('cnpj', data.cnpj)
        .eq('tipo_ativo', data.tipo_ativo)
        .limit(1)
        .maybeSingle();
      existingId = existing?.id || null;
      
      if (existingId && (data.tipo_ativo === 'FUNDO' || data.tipo_ativo === 'FIDC')) {
        const currentDesc = existing.descricao || "";
        if (!currentDesc || currentDesc.startsWith('FUNDO CNPJ') || currentDesc.startsWith('FIDC -')) {
          const realName = await getFundNameFromRegistry(data.cnpj);
          if (realName && realName !== currentDesc) {
            await supabase.from('ativos').update({ descricao: realName }).eq('id', existingId);
          }
        }
      } else if (existingId && !existing.descricao && data.descricao) {
        await supabase.from('ativos').update({ descricao: data.descricao }).eq('id', existingId);
      }
    } else if (data.isin && !data.isin.includes('*')) {
      const { data: existing } = await supabase
        .from('ativos')
        .select('id, descricao')
        .eq('isin', data.isin)
        .limit(1)
        .maybeSingle();
      existingId = existing?.id || null;
      if (existingId && !existing.descricao && data.descricao) {
        await supabase.from('ativos').update({ descricao: data.descricao }).eq('id', existingId);
      }
    } else if (data.ticker) {
      const { data: existing } = await supabase
        .from('ativos')
        .select('id, descricao')
        .eq('ticker', data.ticker)
        .limit(1)
        .maybeSingle();
      existingId = existing?.id || null;
      if (existingId && !existing.descricao && data.descricao) {
        await supabase.from('ativos').update({ descricao: data.descricao }).eq('id', existingId);
      }
    }

    if (existingId) {
      ativosCache.set(identifier, existingId);
    } else {
      // Ativo não existe, vamos criar
      isNew = true;
      if (data.tipo_ativo === 'FUNDO' || data.tipo_ativo === 'FIDC') {
        data.descricao = await resolveFundoDescricao(data);
      } else if (data.cnpj && !data.descricao) {
        const realName = await getFundNameFromRegistry(data.cnpj);
        data.descricao = realName || `${data.tipo_ativo} CNPJ ${data.cnpj}`;
      }

      const payload: Record<string, unknown> = {
        ...data,
        nome_frontend: data.descricao,
        validado: false
      };
      
      // Remove campos nulos para o insert
      const cleanPayload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (v !== null) cleanPayload[k] = v;
      }

      const { data: created, error } = await supabase
        .from('ativos')
        .insert(cleanPayload)
        .select('id')
        .single();

      if (!error && created) {
        existingId = created.id as string;
        ativosCache.set(identifier, existingId);
        result.newAssets.push(data);
      } else {
        console.error(`Erro ao criar ativo ${identifier}:`, error);
        result.errors.push(`Falha ao criar ativo ${data.tipo_ativo}: ${identifier}`);
      }
    }

    if (existingId) {
      const indices = identifiersMap.get(identifier) || [];
      for (const idx of indices) {
        records[idx]['ativo_id'] = existingId;
      }
    }
  }

  return result;
}

interface SubclasseInfo {
  isin: string;
  nome_comercial: string | null;
}

// Seções nas quais o ISIN identifica a subclasse (ex: cotas FIDC SR vs MEZ)
const ISIN_SECTIONS = new Set(['cotas', 'fidc', 'participacoes']);

/**
 * Resolve ISINs inválidos (BR0000000000, com asteriscos, nulos) antes do upsert.
 * Cadeia: 1) subclasse única → 2) name-match → 3) carryover dia anterior → null
 * Modifica records in-place (campo 'isin').
 */
async function resolveIsins(
  records: Record<string, unknown>[],
  fundoCnpj: string,
  dtposicao: string,
): Promise<void> {
  // Coletar CNPJs únicos com ISIN inválido
  const cnpjsNeedingResolution = new Set<string>();
  for (const rec of records) {
    const section = String(rec['section'] || '').toLowerCase();
    if (!ISIN_SECTIONS.has(section)) continue;
    if (!isInvalidIsin(rec['isin'] as string | null)) continue;
    const cnpj = normalizeCnpj(rec['cnpjfundo']) || normalizeCnpj(rec['cnpjemissor']);
    if (cnpj) cnpjsNeedingResolution.add(cnpj);
  }

  if (cnpjsNeedingResolution.size === 0) return;

  const cnpjList = [...cnpjsNeedingResolution];
  console.log(`[import-xml][resolveIsins] ${cnpjList.length} CNPJs com ISIN inválido: ${cnpjList.join(', ')}`);

  // Batch query de subclasses (por cnpj_classe e cnpj_fundo)
  const subclassesPorCnpj = new Map<string, SubclasseInfo[]>();

  const addSubclasses = (rows: any[] | null) => {
    for (const sc of rows || []) {
      const cnpj = normalizeCnpj(sc.cnpj_classe) || normalizeCnpj(sc.cnpj_fundo);
      if (!cnpj || !sc.isin) continue;
      if (!subclassesPorCnpj.has(cnpj)) subclassesPorCnpj.set(cnpj, []);
      const arr = subclassesPorCnpj.get(cnpj)!;
      if (!arr.find((s) => s.isin === sc.isin)) {
        arr.push({ isin: sc.isin, nome_comercial: sc.nome_comercial || null });
      }
    }
  };

  const [{ data: byClasse }, { data: byFundo }] = await Promise.all([
    supabase.from('fundos_caracteristicas').select('cnpj_classe, cnpj_fundo, isin, nome_comercial').in('cnpj_classe', cnpjList).not('isin', 'is', null),
    supabase.from('fundos_caracteristicas').select('cnpj_classe, cnpj_fundo, isin, nome_comercial').in('cnpj_fundo', cnpjList).not('isin', 'is', null),
  ]);
  addSubclasses(byClasse as any[]);
  addSubclasses(byFundo as any[]);

  // Resolver ISIN de cada registro afetado
  for (const rec of records) {
    const section = String(rec['section'] || '').toLowerCase();
    if (!ISIN_SECTIONS.has(section)) continue;
    if (!isInvalidIsin(rec['isin'] as string | null)) continue;

    const cnpj = normalizeCnpj(rec['cnpjfundo']) || normalizeCnpj(rec['cnpjemissor']);
    if (!cnpj) continue;

    const subclasses = subclassesPorCnpj.get(cnpj);
    const nomePapel = String(rec['nomecomercial'] || rec['nomeativo'] || rec['nome'] || '');

    let resolvedIsin: string | null = null;
    let resolveStep = 0;

    // PASSO 1 — subclasse única
    if (subclasses && subclasses.length === 1) {
      resolvedIsin = subclasses[0].isin;
      resolveStep = 1;
    }

    // PASSO 2 — name-match
    if (!resolvedIsin && subclasses && subclasses.length > 1 && nomePapel) {
      let bestScore = 0;
      let bestIsin: string | null = null;
      for (const sc of subclasses) {
        if (!sc.nome_comercial) continue;
        const score = tokenSimilarity(nomePapel, sc.nome_comercial);
        if (score > bestScore) { bestScore = score; bestIsin = sc.isin; }
      }
      if (bestScore >= 0.5) { resolvedIsin = bestIsin; resolveStep = 2; }
    }

    // PASSO 3 — carryover dia anterior
    if (!resolvedIsin) {
      try {
        const rawCnpjFundo = String(rec['cnpjfundo'] || '').trim() || null;
        const rawCnpjEmissor = String(rec['cnpjemissor'] || '').trim() || null;
        const rawCnpj = rawCnpjFundo || rawCnpjEmissor;
        const orParts = [
          rawCnpjFundo ? `cnpjfundo.eq.${rawCnpjFundo}` : null,
          cnpj !== rawCnpjFundo ? `cnpjfundo.eq.${cnpj}` : null,
          rawCnpjEmissor ? `cnpjemissor.eq.${rawCnpjEmissor}` : null,
          cnpj !== rawCnpjEmissor ? `cnpjemissor.eq.${cnpj}` : null,
        ].filter(Boolean).join(',');

        if (rawCnpj && orParts) {
          const { data: prev } = await supabase
            .from('posicao_carteira')
            .select('isin')
            .eq('fundo_cnpj', fundoCnpj)
            .in('section', [...ISIN_SECTIONS])
            .or(orParts)
            .lt('fundo_dtposicao', dtposicao)
            .not('isin', 'is', null)
            .order('fundo_dtposicao', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (prev?.isin && !isInvalidIsin(prev.isin as string)) {
            resolvedIsin = prev.isin as string;
            resolveStep = 3;
          }
        }
      } catch (e) {
        console.warn(`[import-xml][resolveIsins] Erro no carryover CNPJ ${cnpj}:`, e);
      }
    }

    if (resolvedIsin) {
      console.log(`[import-xml][resolveIsins] CNPJ ${cnpj} nome="${nomePapel}" → ISIN ${resolvedIsin} (passo ${resolveStep})`);
      rec['isin'] = resolvedIsin;
    } else {
      console.warn(`[import-xml][resolveIsins] CNPJ ${cnpj} nome="${nomePapel}": ISIN não resolvido → null`);
      rec['isin'] = null;
    }
  }
}

async function parseXmlContent(xmlContent: string, filename: string): Promise<Record<string, unknown>[]> {
  const allRecords: Record<string, unknown>[] = [];

  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  
  const jsonObj = parser.parse(xmlContent);
  
  // Função auxiliar para buscar uma tag recursivamente
  const findTag = (obj: any, targetTag: string): any => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[targetTag]) return obj[targetTag];
    for (const key in obj) {
      const result = findTag(obj[key], targetTag);
      if (result) return result;
    }
    return null;
  };

  // Busca a tag 'fundo' em qualquer nível
  const fundo = findTag(jsonObj, 'fundo');

  if (!fundo || typeof fundo !== 'object') {
    console.error('Estrutura fundo não encontrada no XML');
    return [];
  }

  // Header - busca dentro do fundo ou no objeto todo como fallback
  const header = fundo.header || findTag(jsonObj, 'header') || {};
  const headerData: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(header)) {
    if (typeof value !== 'object' || value === null) {
      headerData[`fundo_${key.toLowerCase()}`] = String(value);
    }
  }
  headerData['arquivo_nome'] = filename;

  // Garante que temos o CNPJ, senão os registros serão inválidos
  if (!headerData['fundo_cnpj']) {
    console.error('CNPJ do fundo não encontrado no header do XML');
    // Tenta buscar CNPJ em qualquer lugar do header caso a tag tenha outro nome
    const possibleCnpj = header.cnpj || header.CNPJ || header.Cnpj;
    if (possibleCnpj) {
      headerData['fundo_cnpj'] = String(possibleCnpj);
    } else {
      return []; // Não processa se não tiver CNPJ
    }
  }

  // Lista de seções conhecidas para evitar processar metadados como seções
  const validSections = new Set([
    'cotas', 'titpublico', 'titprivado', 'termorf', 'despesas', 'provisao', 
    'caixa', 'participacoes', 'acoes', 'imoveis', 'fidc'
  ]);

  // Processa seções
  for (const [sectionKey, sectionValue] of Object.entries(fundo)) {
    const sectionName = sectionKey.toLowerCase();
    
    if (sectionName === 'header' || !validSections.has(sectionName)) continue;

    // Garante que sectionValue seja um array de itens
    const items = Array.isArray(sectionValue) ? sectionValue : [sectionValue];

    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;

      const record: Record<string, unknown> = { ...headerData };
      record['section'] = sectionName;
      record['possui_compromisso'] = false;
      record['fundo_isin'] = normalizeIsin(record['fundo_isin']);

      for (const [key, value] of Object.entries(item)) {
        const tag = key.toLowerCase();
        
        if (typeof value === 'object' && value !== null) {
          if (tag === 'compromisso') {
            record['possui_compromisso'] = true;
          }
          // Processa sub-campos (como os de compromisso)
          for (const [subKey, subValue] of Object.entries(value)) {
            const subTag = subKey.toLowerCase();
            record[`${tag}_${subTag}`] = subValue !== null ? String(subValue) : null;
          }
        } else {
          record[tag] = value !== null ? String(value) : null;
        }
      }

      // Cálculo de valor financeiro se necessário
      if (sectionName === 'cotas' && !record['valorfindisp']) {
        const qt = toNumeric(record['qtdisponivel'] as string);
        const pu = toNumeric(record['puposicao'] as string);
        if (qt && pu) {
          record['valorfindisp'] = qt * pu;
        }
      }

      record['valor_padrao'] = getValorPadrao(record, sectionName);

      // Popula nome_fundo
      if (record['fundo_nome'] && !record['nome_fundo']) {
        record['nome_fundo'] = record['fundo_nome'];
      }

      // A classe faz parte da identidade: JR e SR podem compartilhar CNPJ/data
      // e possuir linhas estruturalmente idênticas.
      record['natural_key'] = await md5Hash(buildNaturalKeySeed(record, sectionName));

      // Normalização: garante que todos os objetos tenham as mesmas chaves
      const normalized: Record<string, unknown> = {};
      for (const col of ALL_TABLE_COLUMNS) {
        normalized[col] = record[col] ?? null;
      }

      allRecords.push(cleanRecord(normalized));
    }
  }

  return allRecords;
}

/**
 * Deduplica registros por natural_key.
 * PostgreSQL não permite múltiplas linhas com a mesma chave no mesmo comando ON CONFLICT.
 * Mantém a última ocorrência. Exclui registros sem natural_key válido.
 */
function dedupeByNaturalKey(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  let skippedNoKey = 0;
  for (const r of records) {
    const key = (r['natural_key'] ?? '') as string;
    if (!key || key.length !== 32) {
      skippedNoKey++;
      continue;
    }
    map.set(key, r);
  }
  if (skippedNoKey > 0) {
    console.warn(`[import-xml] ${skippedNoKey} registros ignorados (natural_key inválido)`);
  }
  return Array.from(map.values());
}

/**
 * Garante que o batch não tenha natural_key duplicados (segurança extra).
 */
function dedupeBatch(batch: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of batch) {
    const key = (r['natural_key'] ?? '') as string;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Remove posição anterior do fundo/data (e ISIN, se informado) antes do upsert — evita linhas órfãs na reimportação. */
async function deleteExistingPosition(
  fundoCnpj: string,
  fundoDtposicao: string,
  fundoIsin?: string | null,
): Promise<void> {
  let q = supabase
    .from('posicao_carteira')
    .delete()
    .eq('fundo_cnpj', fundoCnpj)
    .eq('fundo_dtposicao', fundoDtposicao);
  const isin = String(fundoIsin ?? '').trim();
  if (isin) q = q.eq('fundo_isin', isin);
  else q = q.is('fundo_isin', null);
  const { error } = await q;
  if (error) {
    console.error(`[import-xml] Erro ao limpar posição ${fundoCnpj}/${fundoDtposicao}:`, error);
    throw error;
  }
}

async function uploadData(records: Record<string, unknown>[], batchSize = 500): Promise<{ success: boolean; count: number }> {
  if (records.length === 0) return { success: true, count: 0 };

  const deduped = dedupeByNaturalKey(records);
  if (deduped.length < records.length) {
    console.log(`[import-xml] Removidas ${records.length - deduped.length} duplicatas por natural_key`);
  }

  let totalSent = 0;

  try {
    for (let i = 0; i < deduped.length; i += batchSize) {
      let batch = deduped.slice(i, i + batchSize);
      batch = dedupeBatch(batch);
      if (batch.length === 0) continue;

      const { error } = await supabase
        .from('posicao_carteira')
        .upsert(batch, { onConflict: 'natural_key' });

      if (error) {
        console.error('Erro ao inserir batch:', error);
        return { success: false, count: totalSent };
      }

      totalSent += batch.length;
    }

    return { success: true, count: totalSent };
  } catch (error) {
    console.error('Erro no upload:', error);
    return { success: false, count: totalSent };
  }
}

function yyyymmddToIso(dt: string): string | null {
  if (!/^\d{8}$/.test(dt)) return null;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}

async function enqueueRentabilidadeSnapshotReprocess(
  fundoDtposicao: string,
  fundoCnpj: string,
  fundoIsin: string | null | undefined,
  fundoNome: string | null | undefined,
  source: string,
): Promise<void> {
  const dataRefIso = yyyymmddToIso(fundoDtposicao);
  if (!dataRefIso) return;

  const { error: staleError } = await supabase.rpc('mark_rentabilidade_snapshot_stale', {
    p_data_referencia: dataRefIso,
    p_reason: source,
  });
  if (staleError) {
    console.warn(
      `[import-xml] Falha ao marcar snapshot stale para ${dataRefIso}:`,
      staleError.message,
    );
  }

  const { error: queueError } = await supabase.rpc('enqueue_rentabilidade_snapshot_reprocess', {
    p_data_referencia: dataRefIso,
    p_source: source,
    p_priority: 100,
  });
  if (queueError) {
    console.warn(
      `[import-xml] Falha ao enfileirar snapshot para ${dataRefIso}:`,
      queueError.message,
    );
  }

  if (!fundoIsin?.trim()) {
    console.warn(`[import-xml] Classe sem ISIN; snapshot V2 nao enfileirado para ${fundoCnpj} em ${dataRefIso}`);
    return;
  }
  const { error: v2QueueError } = await supabase.rpc('enqueue_rentabilidade_snapshot_reprocess_v2', {
    p_data_referencia: dataRefIso,
    p_fundo_cnpj: fundoCnpj,
    p_fundo_isin: fundoIsin,
    p_fundo_nome: fundoNome ?? null,
    p_source: source,
    p_priority: 100,
  });
  if (v2QueueError) {
    console.warn(`[import-xml] Falha ao enfileirar snapshot V2 para ${fundoCnpj}/${fundoIsin}:`, v2QueueError.message);
  }
}

function validatePl(records: Record<string, unknown>[]): { plInformado: number; plCalculado: number; diffPerc: number } | null {
  if (records.length === 0) return null;

  const plInformado = toNumeric(records[0]['fundo_patliq'] as string) || 0;
  if (plInformado === 0) return null;

  const sectionsParaPl = new Set(['cotas', 'titpublico', 'titprivado', 'termorf', 'acoes', 'participacoes', 'caixa', 'imoveis', 'fidc']);
  let somaAtivos = 0;

  for (const r of records) {
    const section = r['section'] as string;
    if (sectionsParaPl.has(section)) {
      somaAtivos += (r['valor_padrao'] as number) || 0;
    }
  }

  const receber = toNumeric(records[0]['fundo_valorreceber'] as string) || 0;
  const pagar = toNumeric(records[0]['fundo_valorpagar'] as string) || 0;
  const plCalculado = somaAtivos + receber - pagar;

  const diff = Math.abs(plInformado - plCalculado);
  const diffPerc = plInformado ? (diff / plInformado * 100) : 0;

  return { plInformado, plCalculado, diffPerc };
}

/** Limiar: só substitui o PL base pelo enriquecido com a receber se a diferença for > R$ 50k. */
const PL_RECEBER_MIN_DIFF = 50_000;

/**
 * Calcula o PL efetivo a partir do XML.
 *
 * Fórmula base (todos os fundos):
 *   plBase = valorativos − valorpagar − vlcotasresgatar
 *
 * Fórmula enriquecida (inclui contas a receber):
 *   plReceber = valorativos + valorreceber − valorpagar − vlcotasresgatar
 *
 * Regra de seleção:
 *   1. Se valorativos = 0 → fallback para patliq do header XML.
 *   2. Se plReceber < plBase → usa plBase (guard: não piora o PL).
 *   3. Se (plReceber − plBase) ≤ PL_RECEBER_MIN_DIFF (50k) → usa plBase (diferença irrelevante).
 *   4. Caso contrário → usa plReceber (valorreceber é materialmente relevante).
 *
 * O valor calculado é escrito em fundo_patliq de todos os registros do lote.
 */
function calcularPlEfetivo(
  records: Record<string, unknown>[]
): { plEfetivo: number; fonte: 'valorativos' | 'valorativos_mais_receber' | 'patliq_fallback'; valorativos: number; valorreceber: number; valorpagar: number; vlcotasresgatar: number; patliqOriginal: number } {
  const primeiro = records[0];
  const valorativos     = toNumeric(primeiro['fundo_valorativos']     as string) || 0;
  const valorreceber    = toNumeric(primeiro['fundo_valorreceber']    as string) || 0;
  const valorpagar      = toNumeric(primeiro['fundo_valorpagar']      as string) || 0;
  const vlcotasresgatar = toNumeric(primeiro['fundo_vlcotasresgatar'] as string) || 0;
  const patliqOriginal  = toNumeric(primeiro['fundo_patliq']          as string) || 0;

  const cnpj = (primeiro['fundo_cnpj'] as string) || '?';

  let plEfetivo: number;
  let fonte: 'valorativos' | 'valorativos_mais_receber' | 'patliq_fallback';

  if (valorativos <= 0) {
    plEfetivo = patliqOriginal;
    fonte = 'patliq_fallback';
    console.warn(`[import-xml] AVISO: <valorativos> ausente/zerado para ${cnpj} — usando <patliq> como fallback: ${patliqOriginal}`);
  } else {
    const plBase     = valorativos - valorpagar - vlcotasresgatar;
    const plReceber  = valorativos + valorreceber - valorpagar - vlcotasresgatar;
    const diff       = plReceber - plBase;

    if (plReceber > plBase && diff > PL_RECEBER_MIN_DIFF) {
      plEfetivo = plReceber;
      fonte = 'valorativos_mais_receber';
      console.log(
        `[import-xml] PL enriquecido para ${cnpj}: ` +
        `${valorativos}(va) + ${valorreceber}(vr) - ${valorpagar}(vp) - ${vlcotasresgatar}(cotas) = ${plEfetivo} ` +
        `(base=${plBase}, uplift=${diff.toFixed(0)})`,
      );
    } else {
      plEfetivo = plBase;
      fonte = 'valorativos';
      if (valorreceber > 0) {
        console.log(
          `[import-xml] PL base para ${cnpj}: ` +
          `${valorativos}(va) - ${valorpagar}(vp) - ${vlcotasresgatar}(cotas) = ${plEfetivo} ` +
          `(vr=${valorreceber} ignorado — diff ${diff.toFixed(0)} ≤ ${PL_RECEBER_MIN_DIFF})`,
        );
      } else {
        console.log(
          `[import-xml] PL calculado para ${cnpj}: ` +
          `${valorativos}(va) - ${valorpagar}(vp) - ${vlcotasresgatar}(cotas) = ${plEfetivo}`,
        );
      }
    }
  }

  const valorcota = toNumeric(primeiro['fundo_valorcota'] as string) || 0;
  const quantidade = toNumeric(primeiro['fundo_quantidade'] as string) || 0;
  const plCota = valorcota > 0 && quantidade > 0 ? valorcota * quantidade : 0;

  // valorreceber material no header → PL deve incluir contas a receber (mesmo se diff ≤ limiar na regra acima)
  if (valorativos > 0 && valorreceber > PL_RECEBER_MIN_DIFF) {
    const plReceberFull = valorativos + valorreceber - valorpagar - vlcotasresgatar;
    if (plReceberFull > plEfetivo) {
      plEfetivo = plReceberFull;
      fonte = 'valorativos_mais_receber';
    }
  }

  // Piso: patliq declarado, PL por cota×quantidade, ou patliq quando calculado ficou abaixo
  const plFloor = Math.max(
    patliqOriginal > 0 ? patliqOriginal : 0,
    plCota > 0 ? plCota : 0,
  );
  if (plFloor > 0 && plEfetivo < plFloor) {
    console.warn(
      `[import-xml] AVISO: PL calculado (${plEfetivo.toFixed(2)}) abaixo do piso ` +
      `(patliq=${patliqOriginal.toFixed(2)}, cota×qtd=${plCota.toFixed(2)}) para ${cnpj}`,
    );
    plEfetivo = plFloor;
    fonte = 'patliq_fallback';
  }

  // Propaga o PL efetivo para todos os registros do lote
  for (const r of records) {
    r['fundo_patliq'] = plEfetivo;
  }

  return { plEfetivo, fonte, valorativos, valorreceber, valorpagar, vlcotasresgatar, patliqOriginal };
}

interface ProcessResult {
  filename: string;
  success: boolean;
  records: number;
  fundo_cnpj?: string;
  fundo_dtposicao?: string;
  nome_fundo?: string;
  validation?: {
    plInformado: number;
    plCalculado: number;
    diffPerc: number;
    status: string;
  };
  patliq_calculado?: {
    efetivo: number;
    fonte: 'valorativos' | 'patliq_fallback';
    valorativos: number;
    valorpagar: number;
    vlcotasresgatar: number;
    patliq_original: number;
  };
  newAssets?: AtivoData[];
  errors?: string[];
  error?: string;
}

serve(async (req: Request) => {
  console.log(`[import-xml] Recebendo requisição: ${req.method}`);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    console.log(`[import-xml] Content-Type: ${contentType}`);
    
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Content-Type deve ser multipart/form-data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const files = formData.getAll('files');

    console.log(`[import-xml] Quantidade de arquivos recebidos: ${files.length}`);

    if (files.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum arquivo enviado' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results: ProcessResult[] = [];
    let totalRecords = 0;
    let successCount = 0;

    for (const file of files) {
      if (!(file instanceof File)) continue;
      
      const filename = file.name;
      console.log(`[import-xml] Processando: ${filename}`);

      try {
        const xmlContent = await file.text();
        const records = await parseXmlContent(xmlContent, filename);

        if (records.length === 0) {
          results.push({
            filename,
            success: false,
            records: 0,
            error: 'Nenhum registro encontrado no XML'
          });
          continue;
        }

        // Sincroniza ativos
        const syncResult = await syncAtivos(records);
        if (syncResult.newAssets.length > 0) {
          const identifiers = syncResult.newAssets
            .map((asset) => asset.descricao || asset.cnpj || asset.isin || asset.ticker || asset.codigo_cetip_selic || 'SEM_IDENTIFICADOR')
            .slice(0, 10);
          console.warn(`[import-xml] ${syncResult.newAssets.length} novos ativos detectados em ${filename}: ${identifiers.join(' | ')}`);
        }
        if (syncResult.errors.length > 0) {
          console.error(`[import-xml] Erros ao sincronizar ativos em ${filename}:`, syncResult.errors);
        }

        // Calcula PL efetivo (nova lógica: inclui valorreceber quando materialmente relevante)
        const plCalc = calcularPlEfetivo(records);

        // Validação de PL (usa o fundo_patliq já atualizado pelo calcularPlEfetivo)
        const validation = validatePl(records);

        // Resolve ISINs inválidos antes do upsert
        await resolveIsins(
          records,
          records[0]['fundo_cnpj'] as string,
          records[0]['fundo_dtposicao'] as string,
        );

        // Limpa posição anterior (reimportação substitui o lote inteiro)
        await deleteExistingPosition(
          records[0]['fundo_cnpj'] as string,
          records[0]['fundo_dtposicao'] as string,
          (records[0]['fundo_isin'] as string) || null,
        );

        // Upload para o banco
        const { success, count } = await uploadData(records);

        const result: ProcessResult = {
          filename,
          success,
          records: count,
          fundo_cnpj: records[0]['fundo_cnpj'] as string,
          fundo_dtposicao: records[0]['fundo_dtposicao'] as string,
          nome_fundo: records[0]['nome_fundo'] as string,
          newAssets: syncResult.newAssets,
          errors: syncResult.errors
        };

        result.patliq_calculado = {
          efetivo: plCalc.plEfetivo,
          fonte: plCalc.fonte as any,
          valorativos: plCalc.valorativos,
          valorpagar: plCalc.valorpagar,
          vlcotasresgatar: plCalc.vlcotasresgatar,
          patliq_original: plCalc.patliqOriginal,
        };

        if (validation) {
          result.validation = {
            ...validation,
            status: validation.diffPerc <= 1.0 ? 'OK' : `ALERTA (Diff: ${validation.diffPerc.toFixed(2)}%)`
          };
        }

        if (success) {
          totalRecords += count;
          successCount++;
          const fundoCnpj = records[0]['fundo_cnpj'] as string;
          const fundoDtposicao = records[0]['fundo_dtposicao'] as string;
          const { error: cacheError } = await supabase.rpc('upsert_fund_last_update_cache', {
            p_fundo_cnpj: fundoCnpj,
          });
          if (cacheError) {
            console.warn(`[import-xml] Falha ao atualizar cache do dashboard para ${fundoCnpj}:`, cacheError.message);
          }
          const mesRefConferencia =
            fundoDtposicao.length >= 6
              ? `${fundoDtposicao.slice(0, 4)}-${fundoDtposicao.slice(4, 6)}`
              : null;
          const { error: conferenciaCacheError } = await supabase.rpc(
            'refresh_conferencia_taxas_mes_cache',
            {
              p_fundo_cnpj: fundoCnpj,
              ...(mesRefConferencia ? { p_mes_ref: mesRefConferencia } : {}),
            },
          );
          if (conferenciaCacheError) {
            console.warn(
              `[import-xml] Falha ao atualizar cache de conferência para ${fundoCnpj}:`,
              conferenciaCacheError.message,
            );
          }
          await enqueueRentabilidadeSnapshotReprocess(
            fundoDtposicao,
            fundoCnpj,
            (records[0]['fundo_isin'] as string | null | undefined),
            (records[0]['nome_fundo'] as string | null | undefined) ?? (records[0]['fundo_nome'] as string | null | undefined),
            'xml_import',
          );
        } else {
          result.error = 'Falha ao inserir registros no banco';
        }

        results.push(result);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[import-xml] Erro em ${filename}:`, error);
        results.push({
          filename,
          success: false,
          records: 0,
          error: errorMessage
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: successCount > 0,
        summary: {
          totalFiles: files.length,
          successFiles: successCount,
          errorFiles: files.length - successCount,
          totalRecords
        },
        results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[import-xml] Erro inesperado:', error);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
