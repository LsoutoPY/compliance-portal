import type { ArestaRede, NoRede, RedeSnapshot } from './snapshot';

export interface MetricaEstrutura {
  fundo_cnpj: string;
  data_competencia: string;
  patrimonio_liquido: number | null;
  numero_cotistas: number | null;
  origem: string;
  arquivo_origem?: string | null;
}
export interface PerfilEstrutura {
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  estrutura: string | null;
  gestor_principal: string | null;
  administrador: string | null;
  tipo_anbima: string | null;
  categoria_anbima: string | null;
  status: string | null;
  updated_at: string | null;
}
export interface RegistroEstrutura {
  id: string;
  tipo: 'analise' | 'contraparte';
  entidade_chave: string;
  data_referencia: string;
  status: string;
  nota: string;
  fonte: string | null;
  responsavel: string | null;
  proxima_revisao: string | null;
  created_at: string;
}
export const ORIGEM_INFORME_DIARIO = 'informe_diario_fi';
export const ORIGENS_INFORME_MENSAL = new Set(['medidas_estruturados', 'informe_mensal_fidc']);
export const LIMITES_ESTRUTURA = {
  relevancia: 0.2, relevanciaAlta: 0.5, poucosCotistas: 10,
  presencaInterna: 0.7, intermediario: 0.9, profundidade: 4, concentracao: 0.4,
  saidasVisiveis: 6,
};
export type LimitesEstrutura = typeof LIMITES_ESTRUTURA;
export type SeveridadeEstrutura = 'critico' | 'atencao' | 'dados';
export interface AlertaEstrutura {
  codigo: string;
  severidade: SeveridadeEstrutura;
  titulo: string;
  evidencia: string;
  acao: string;
}
export interface MotivoScore {
  codigo: string;
  pontos: number;
  titulo: string;
  evidencia: string;
}
export interface LigacaoEstrutura {
  source: string;
  target: string;
  valor: number | null;
  peso: number;
  tranches: number;
}
export interface ItemEstrutura {
  no: NoRede;
  perfil?: PerfilEstrutura;
  metrica?: MetricaEstrutura;
  pl: number | null;
  fontePl: 'CVM' | 'XML' | null;
  dataPl: string | null;
  cotistas: number | null;
  cotistasPassivo: number | null;
  dataPassivo: string | null;
  investidoresInternos: number;
  valorNosso: number | null;
  relevancia: number | null;
  coberturaCotistas: number | null;
  entradas: LigacaoEstrutura[];
  saidas: LigacaoEstrutura[];
  alertas: AlertaEstrutura[];
  alertasDescendentes: number;
  prioridade: number;
  /** Maior cadeia a partir deste nó (não é um “nível” absoluto da entidade). */
  profundidade: number;
  /** Menor caminho desde um fundo monitorado até aqui. */
  minDepthOrigem: number | null;
  /** Maior caminho desde um fundo monitorado até aqui. */
  maxDepthOrigem: number | null;
  nCaminhosOrigem: number;
  nEstruturasOrigem: number;
  scoreAtencao: number;
  motivosScore: MotivoScore[];
}
export interface ResumoEstrutura {
  nFundos: number;
  nCompartilhados: number;
  nRelacoes: number;
  nAtivos: number;
  nAlertas: number;
  profundidadeMax: number;
}
export interface ConcentracaoEstrutura {
  nome: string;
  fundos: string[];
  percentual: number;
  alerta: boolean;
}
export interface AnaliseEstrutura {
  itens: Map<string, ItemEstrutura>;
  principais: ItemEstrutura[];
  gestores: ConcentracaoEstrutura[];
  administradores: ConcentracaoEstrutura[];
  data: string;
  resumo: ResumoEstrutura;
}
export const cnpjEstrutura = (value?: string | null) => (value ?? '').replace(/\D/g, '');
export function formatarCnpjEstrutura(cnpj?: string | null): string {
  const d = cnpjEstrutura(cnpj);
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d;
}
/** PostgREST às vezes devolve date como ISO completo; a comparação lexicográfica então descarta o próprio dia da referência. */
export function dataCompetenciaEstrutura(value?: string | null): string {
  return String(value ?? '').slice(0, 10);
}
/** Nome comparável ao cadastro CVM/Finvest: tira tipo do fundo e ruído societário. */
export function chaveNomeCvm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\b(FICFIF|FIF|FIC|FIM|FIDC|FII|FIP)\b/g, ' ')
    .replace(/FUNDO DE INVESTIMENTO(?: FINANCEIRO)?(?: EM COTAS DE(?: FUNDOS? DE INVESTIMENTO(?: FINANCEIRO)?)?)?/g, ' ')
    .replace(/\b(RESPONSABILIDADE LIMITADA|RESP LIMITADA|CREDITO PRIVADO|CRED\.? PRIV\.?|MULTIMERCADO|COTAS)\b/g, ' ')
    .replace(/[^A-Z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function dvCnpj(base12: string): string {
  const calc = (nums: number[], pesos: number[]) => {
    const soma = nums.reduce((s, n, i) => s + n * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const n = base12.split('').map(Number);
  const d1 = calc(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc([...n, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}
/** Classe CVM típica: raiz (8) + ordem 0001 + DV. */
export function cnpjClasseDaRaiz(raiz: string, ordem = '0001'): string {
  const r = raiz.replace(/\D/g, '').padStart(8, '0').slice(-8);
  const o = ordem.replace(/\D/g, '').padStart(4, '0').slice(-4);
  if (r.length !== 8) return '';
  return r + o + dvCnpj(r + o);
}
export function aliasesPerfilPorNome(
  fundos: Array<{ cnpj?: string | null; nome?: string | null }>,
  catalogo: Array<{ codigo?: string | null; nome?: string | null }>,
): PerfilEstrutura[] {
  const porChave = new Map<string, string[]>();
  for (const item of catalogo) {
    const raiz = String(item.codigo ?? '').replace(/\D/g, '').padStart(8, '0').slice(-8);
    const chave = chaveNomeCvm(item.nome ?? '');
    if (raiz.length !== 8 || chave.length < 4) continue;
    porChave.set(chave, [...(porChave.get(chave) ?? []), raiz]);
  }
  const out: PerfilEstrutura[] = [];
  const visto = new Set<string>();
  for (const fundo of fundos) {
    const carteira = cnpjEstrutura(fundo.cnpj);
    const chave = chaveNomeCvm(fundo.nome ?? '');
    if (carteira.length !== 14 || chave.length < 4) continue;
    const exatos = porChave.get(chave) ?? [];
    const raizes = [...new Set(exatos)];
    if (raizes.length !== 1) continue;
    const cvm = cnpjClasseDaRaiz(raizes[0]);
    if (!cvm || cvm === carteira) continue;
    const id = `${carteira}|${cvm}`;
    if (visto.has(id)) continue;
    visto.add(id);
    out.push({
      cnpj_classe: cvm,
      cnpj_fundo: carteira,
      estrutura: 'Classe',
      gestor_principal: null,
      administrador: null,
      tipo_anbima: null,
      categoria_anbima: null,
      status: null,
      updated_at: null,
    });
  }
  return out;
}
/** Uma linha recente com PL e, se diferente, a mais recente com cotistas. */
export function reduzirMetricasPorFundo(rows: MetricaEstrutura[]): MetricaEstrutura[] {
  const grupos = new Map<string, MetricaEstrutura[]>();
  for (const row of rows) {
    const chave = `${cnpjEstrutura(row.fundo_cnpj)}:${row.origem}`;
    const list = grupos.get(chave) ?? [];
    list.push(row);
    grupos.set(chave, list);
  }
  const out: MetricaEstrutura[] = [];
  for (const list of grupos.values()) {
    const sorted = [...list].sort((a, b) => dataCompetenciaEstrutura(b.data_competencia).localeCompare(dataCompetenciaEstrutura(a.data_competencia)));
    const escolhidas = [
      sorted[0],
      sorted.find(r => r.numero_cotistas != null),
      sorted.find(r => r.patrimonio_liquido != null),
    ].filter((r, i, arr): r is MetricaEstrutura => !!r && arr.indexOf(r) === i);
    out.push(...escolhidas);
  }
  return out;
}
/** Dígitos e máscara CVM — a consulta nunca deve interpolar a máscara num `.or()` (o `/` quebra o PostgREST). */
export function loteCnpjConsulta(cnpjs: string[]): { digits: string[]; formatted: string[] } {
  const digits = [...new Set(cnpjs.map(cnpjEstrutura).filter(c => c.length === 14))];
  return { digits, formatted: digits.map(formatarCnpjEstrutura) };
}
export const dataIsoEstrutura = (v: string) => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v.slice(0, 10);
export const normalizarBuscaEstrutura = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function correspondeBuscaEstrutura(item: ItemEstrutura, busca: string): boolean {
  const q = normalizarBuscaEstrutura(busca.trim());
  if (!q) return true;
  const texto = normalizarBuscaEstrutura([item.no.nome, item.perfil?.gestor_principal, item.perfil?.administrador, item.no.gestorNome, item.no.administradorNome].join(' '));
  const digits = cnpjEstrutura(q);
  return texto.includes(q) || (digits.length > 0 && /^[\d.\-/\s]+$/.test(q) && cnpjEstrutura(item.no.cnpj).includes(digits));
}

/** Classe exata antes de fundo. Não herda o cadastro de uma classe irmã. */
export function escolherPerfilEstrutura(cnpj: string, perfis: PerfilEstrutura[]): PerfilEstrutura | undefined {
  const rank = (p: PerfilEstrutura) => (cnpjEstrutura(p.cnpj_classe) === cnpj ? 4 : 0)
    + (/^(classe|fundo)$/i.test(p.estrutura ?? '') ? 2 : 0);
  return perfis.filter(p => cnpjEstrutura(p.cnpj_classe) === cnpj ||
    (cnpjEstrutura(p.cnpj_fundo) === cnpj && (!p.cnpj_classe || cnpjEstrutura(p.cnpj_classe) === cnpj || /^fundo$/i.test(p.estrutura ?? ''))))
    .sort((a, b) => rank(b) - rank(a) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
}

export function ultimoRegistroEstrutura(registros: RegistroEstrutura[], chave: string, tipo: RegistroEstrutura['tipo'], data: string) {
  return registros.filter(r => r.entidade_chave === chave && r.tipo === tipo && r.data_referencia <= data)
    .sort((a, b) => b.data_referencia.localeCompare(a.data_referencia) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
}

export function origemInformeDiario(origem?: string | null): boolean {
  return origem === ORIGEM_INFORME_DIARIO;
}

export function origemInformeMensal(origem?: string | null): boolean {
  return !!origem && ORIGENS_INFORME_MENSAL.has(origem);
}

function chavesCnpjLookup(cnpj: string, extras: Array<string | null | undefined> = []): string[] {
  return [...new Set([cnpj, ...extras].map(cnpjEstrutura).filter(c => c.length === 14))];
}

function metricasAte(metricas: MetricaEstrutura[], chaves: string[], data: string): MetricaEstrutura[] {
  const set = new Set(chaves);
  const limite = dataCompetenciaEstrutura(data);
  return metricas.filter(m => set.has(cnpjEstrutura(m.fundo_cnpj)) && dataCompetenciaEstrutura(m.data_competencia) <= limite);
}

function escolherEmLista(lista: MetricaEstrutura[]): MetricaEstrutura | undefined {
  const maisRecente = (pred: (m: MetricaEstrutura) => boolean) =>
    [...lista].filter(pred).sort((a, b) => dataCompetenciaEstrutura(b.data_competencia).localeCompare(dataCompetenciaEstrutura(a.data_competencia)))[0];
  return maisRecente(m => origemInformeDiario(m.origem) && m.patrimonio_liquido != null)
    ?? maisRecente(m => origemInformeMensal(m.origem) && m.patrimonio_liquido != null)
    ?? maisRecente(m => origemInformeDiario(m.origem))
    ?? maisRecente(m => origemInformeMensal(m.origem))
    ?? maisRecente(() => true);
}

/**
 * CNPJs com os quais a CVM pode ter publicado PL/cotistas deste fundo:
 * o da carteira e o par classe/fundo do cadastro (ANBIMA).
 */
export function cnpjsCvmDoNo(cnpj: string, perfis: PerfilEstrutura[]): string[] {
  const chave = cnpjEstrutura(cnpj);
  const out = new Set<string>(chave.length === 14 ? [chave] : []);
  for (const p of perfis) {
    const classe = cnpjEstrutura(p.cnpj_classe);
    const fundo = cnpjEstrutura(p.cnpj_fundo);
    if (classe !== chave && fundo !== chave) continue;
    if (classe.length === 14) out.add(classe);
    if (fundo.length === 14) out.add(fundo);
  }
  return [...out];
}

export function cnpjsParaMetricasEstrutura(cnpjsNos: string[], perfis: PerfilEstrutura[]): string[] {
  const out = new Set<string>();
  for (const cnpj of cnpjsNos) for (const c of cnpjsCvmDoNo(cnpj, perfis)) out.add(c);
  return [...out].sort();
}

/** Informe Diário com PL prevalece; senão o mensal; senão a métrica mais recente daquele CNPJ. */
export function escolherMetricaEstrutura(
  metricas: MetricaEstrutura[],
  cnpj: string,
  data: string,
  extras: Array<string | null | undefined> = [],
): MetricaEstrutura | undefined {
  const chave = cnpjEstrutura(cnpj);
  if (!chave) return undefined;
  return escolherEmLista(metricasAte(metricas, [chave], data))
    ?? escolherEmLista(metricasAte(metricas, chavesCnpjLookup(cnpj, extras), data));
}

/** Cotistas CVM: o CNPJ exato primeiro; se faltar, classe/fundo relacionados. */
export function escolherCotistasEstrutura(
  metricas: MetricaEstrutura[],
  cnpj: string,
  data: string,
  extras: Array<string | null | undefined> = [],
): number | null {
  const comCotistas = (lista: MetricaEstrutura[]) =>
    [...lista]
      .filter(m => m.numero_cotistas != null && m.numero_cotistas >= 0)
      .sort((a, b) => dataCompetenciaEstrutura(b.data_competencia).localeCompare(dataCompetenciaEstrutura(a.data_competencia))
        || Number(origemInformeDiario(b.origem)) - Number(origemInformeDiario(a.origem)))[0];
  const chave = cnpjEstrutura(cnpj);
  const direta = chave ? comCotistas(metricasAte(metricas, [chave], data)) : undefined;
  const relacionada = comCotistas(metricasAte(metricas, chavesCnpjLookup(cnpj, extras), data));
  return direta?.numero_cotistas ?? relacionada?.numero_cotistas ?? null;
}

export function entidadesContraparte(no: NoRede) {
  return [
    { papel: no.tipo === 'fundo' ? 'Fundo' : 'Contraparte / emissor', cnpj: no.tipo === 'fundo' ? no.cnpj : no.cnpjContraparte, nome: no.nome },
    { papel: 'Gestor', cnpj: no.cnpjGestor, nome: no.gestorNome },
    { papel: 'Administrador', cnpj: no.cnpjAdm, nome: no.administradorNome },
  ].filter(e => cnpjEstrutura(e.cnpj).length === 14).map(e => ({ ...e, cnpj: cnpjEstrutura(e.cnpj) }));
}

/** Pontos só para sinais de atenção/críticos — dados faltantes não inflacionam o score. */
export function pontosDoAlerta(alerta: AlertaEstrutura): number {
  const codigo = alerta.codigo.split(':')[0];
  if (alerta.severidade === 'dados') return 0;
  if (codigo === 'relevancia') return alerta.severidade === 'critico' ? 35 : 18;
  if (codigo === 'contraparte') return 30;
  if (codigo === 'ciclo') return 16;
  if (codigo === 'intermediario') return 14;
  if (codigo === 'cotistas' || codigo === 'presenca') return 12;
  if (codigo === 'profundidade' || codigo === 'acesso_profundo') return 10;
  if (codigo === 'repetido') return 8;
  if (codigo === 'inconsistencia' || codigo === 'cotistas_inconsistentes') return 8;
  return alerta.severidade === 'critico' ? 20 : 8;
}

export function pontuarAlertas(alertas: AlertaEstrutura[]): MotivoScore[] {
  return alertas
    .map(a => ({ codigo: a.codigo, pontos: pontosDoAlerta(a), titulo: a.titulo, evidencia: a.evidencia }))
    .filter(m => m.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos);
}

export function rotuloScoreAtencao(score: number): 'alta' | 'investigar' | 'acompanhar' | 'neutro' {
  if (score >= 50) return 'alta';
  if (score >= 25) return 'investigar';
  if (score >= 10) return 'acompanhar';
  return 'neutro';
}

export function resumirAnaliseEstrutura(itens: Map<string, ItemEstrutura>, nRelacoes: number): ResumoEstrutura {
  const lista = [...itens.values()];
  const fundos = lista.filter(i => i.no.tipo === 'fundo');
  return {
    nFundos: fundos.length,
    nCompartilhados: fundos.filter(i => i.entradas.filter(e => itens.has(e.source)).length > 1 || i.nEstruturasOrigem > 1).length,
    nRelacoes,
    nAtivos: lista.filter(i => i.no.tipo === 'ativo').length,
    nAlertas: lista.filter(i => i.alertas.some(a => a.severidade !== 'dados')).length,
    profundidadeMax: Math.max(0, ...lista.map(i => i.maxDepthOrigem ?? i.profundidade)),
  };
}

/** Tranches são somadas em valor, mas cada investidor conta uma única vez. */
export function agruparLigacoesEstrutura(arestas: ArestaRede[], nos: Map<string, NoRede>): LigacaoEstrutura[] {
  const out = new Map<string, LigacaoEstrutura>();
  for (const e of arestas) {
    if (e.tipo === 'passivo' || !nos.has(e.source) || !nos.has(e.target)) continue;
    const pl = nos.get(e.source)?.patrimonioLiquido;
    const valor = e.valorFinanceiro ?? (pl != null && pl > 0 && e.pctPl > 0 ? pl * e.pctPl : null);
    if (valor != null && (!Number.isFinite(valor) || valor <= 0)) continue;
    if (!Number.isFinite(e.pctPl) || e.pctPl < 0) continue;
    const key = `${e.source}|${e.target}`;
    const anterior = out.get(key);
    if (anterior) {
      anterior.valor = anterior.valor == null || valor == null ? null : anterior.valor + valor;
      anterior.peso += e.pctPl;
      anterior.tranches++;
    } else out.set(key, { source: e.source, target: e.target, valor, peso: e.pctPl, tranches: 1 });
  }
  return [...out.values()];
}

/** Mesmo PL/cotistas/data em CNPJs distintos = cópia de alias; fica só no fundo com maior posição nossa. */
export function metricasSemCopiaEntreCnpjs(
  metricas: MetricaEstrutura[],
  pesoPorCnpj: Map<string, number> = new Map(),
): MetricaEstrutura[] {
  const grupos = new Map<string, MetricaEstrutura[]>();
  for (const m of metricas) {
    const fp = `${m.origem}|${dataCompetenciaEstrutura(m.data_competencia)}|${m.patrimonio_liquido}|${m.numero_cotistas}`;
    const list = grupos.get(fp) ?? [];
    list.push(m);
    grupos.set(fp, list);
  }
  const manter = new Set<MetricaEstrutura>();
  for (const list of grupos.values()) {
    const cnpjs = [...new Set(list.map(m => cnpjEstrutura(m.fundo_cnpj)))];
    if (cnpjs.length <= 1) {
      list.forEach(m => manter.add(m));
      continue;
    }
    const vencedor = cnpjs.sort((a, b) => (pesoPorCnpj.get(b) ?? 0) - (pesoPorCnpj.get(a) ?? 0) || a.localeCompare(b))[0];
    list.filter(m => cnpjEstrutura(m.fundo_cnpj) === vencedor).forEach(m => manter.add(m));
  }
  return metricas.filter(m => manter.has(m));
}

export function analisarEstrutura(snapshot: RedeSnapshot, metricasBrutas: MetricaEstrutura[] = [], perfis: PerfilEstrutura[] = [], registros: RegistroEstrutura[] = [], limites = LIMITES_ESTRUTURA): AnaliseEstrutura {
  const data = dataIsoEstrutura(snapshot.dtposicao);
  const nos = new Map(snapshot.nos.filter(n => n.tipo !== 'cotista').map(n => [n.key, n]));
  const ligacoes = agruparLigacoesEstrutura(snapshot.arestas, nos);
  const saidas = new Map<string, LigacaoEstrutura[]>();
  const entradas = new Map<string, LigacaoEstrutura[]>();
  for (const e of ligacoes) {
    saidas.set(e.source, [...(saidas.get(e.source) ?? []), e]);
    entradas.set(e.target, [...(entradas.get(e.target) ?? []), e]);
  }
  const principais = [...nos.values()].filter(n => n.tipo === 'fundo' && snapshot.monitoredCnpjs.has(cnpjEstrutura(n.cnpj)));
  const alcance = new Set(principais.map(n => n.key));
  const fila = [...alcance];
  for (let i = 0; i < fila.length; i++) for (const e of saidas.get(fila[i]) ?? []) {
    if (!alcance.has(e.target)) { alcance.add(e.target); fila.push(e.target); }
  }
  const pesoPorCnpj = new Map<string, number>();
  for (const key of alcance) {
    const cnpj = cnpjEstrutura(nos.get(key)?.cnpj);
    if (cnpj.length !== 14) continue;
    const internas = (entradas.get(key) ?? []).filter(e => snapshot.monitoredCnpjs.has(cnpjEstrutura(nos.get(e.source)?.cnpj)));
    const valor = internas.reduce((s, e) => s + (e.valor ?? 0), 0);
    pesoPorCnpj.set(cnpj, (pesoPorCnpj.get(cnpj) ?? 0) + valor);
  }
  const metricas = metricasSemCopiaEntreCnpjs(metricasBrutas, pesoPorCnpj);
  const itens = new Map<string, ItemEstrutura>();
  for (const key of alcance) {
    const no = nos.get(key)!;
    const cnpj = cnpjEstrutura(no.cnpj);
    const perfil = escolherPerfilEstrutura(cnpj, perfis);
    const chavesCvm = cnpjsCvmDoNo(cnpj, perfis);
    const metrica = escolherMetricaEstrutura(metricas, cnpj, data, chavesCvm);
    const dataXml = no.dataCarteira ? dataIsoEstrutura(no.dataCarteira) : null;
    const xmlValido = dataXml != null && dataXml <= data;
    const pl = metrica?.patrimonio_liquido ?? (xmlValido ? no.patrimonioLiquido ?? null : null);
    const fontePl = metrica?.patrimonio_liquido != null ? 'CVM' : pl != null ? 'XML' : null;
    const dataPl = fontePl === 'CVM' ? metrica!.data_competencia : fontePl === 'XML' ? dataXml : null;
    const entrada = entradas.get(key) ?? [];
    const internas = entrada.filter(e => snapshot.monitoredCnpjs.has(cnpjEstrutura(nos.get(e.source)?.cnpj)));
    const valorNosso = internas.every(e => e.valor != null) ? internas.reduce((s, e) => s + e.valor!, 0) : null;
    const relevancia = valorNosso != null && pl != null && pl > 0 ? valorNosso / pl : null;
    const cotistas = escolherCotistasEstrutura(metricas, cnpj, data, chavesCvm);
    const investidoresInternos = internas.filter(e => e.valor != null && e.valor > 0).length;
    const coberturaCotistas = cotistas != null && cotistas > 0 && investidoresInternos <= cotistas ? investidoresInternos / cotistas : null;
    const item: ItemEstrutura = { no, perfil, metrica, pl, fontePl, dataPl, cotistas, cotistasPassivo: null, dataPassivo: null, investidoresInternos, valorNosso, relevancia, coberturaCotistas, entradas: entrada, saidas: saidas.get(key) ?? [], alertas: [], alertasDescendentes: 0, prioridade: 0, profundidade: 0, minDepthOrigem: null, maxDepthOrigem: null, nCaminhosOrigem: 0, nEstruturasOrigem: 0, scoreAtencao: 0, motivosScore: [] };
    const alertar = (codigo: string, severidade: SeveridadeEstrutura, titulo: string, evidencia: string, acao: string) => item.alertas.push({ codigo, severidade, titulo, evidencia, acao });
    if (no.tipo === 'fundo') {
      if (pl == null || pl <= 0) alertar('pl', 'dados', 'PL indisponível ou não positivo', 'Não é possível calcular a relevância.', 'Importar e conciliar o PL do fundo-alvo.');
      if (relevancia != null && relevancia > 1.001) alertar('inconsistencia', 'dados', 'Posições excedem o PL', 'Relevância acima de 100%; verificar datas, classes e valores.', 'Conciliar posições e denominador antes de decidir.');
      else if (relevancia != null && relevancia >= limites.relevancia) alertar('relevancia', relevancia >= limites.relevanciaAlta ? 'critico' : 'atencao', 'Participação relevante', `${(relevancia * 100).toFixed(2)}% do PL do alvo em posições diretas de fundos monitorados.`, 'Avaliar dependência, governança e estratégia de saída.');
      if (cotistas == null) alertar('cotistas_ausentes', 'dados', 'Cotistas não informados', 'Sem número de cotistas CVM até a referência.', 'Importar Informe Diário ou Informe Mensal e verificar a cobertura da fonte.');
      else if (cotistas <= limites.poucosCotistas) alertar('cotistas', 'atencao', 'Poucos cotistas', `${cotistas} cotistas informados pela CVM.`, 'Revisar concentração do passivo e identificar cotistas relevantes.');
      if (cotistas != null && investidoresInternos > cotistas) alertar('cotistas_inconsistentes', 'dados', 'Contagem de cotistas divergente', `${investidoresInternos} fundos identificados para ${cotistas} cotistas CVM.`, 'Conciliar datas e a classe antes de usar a proporção.');
      if (coberturaCotistas != null && coberturaCotistas >= limites.presencaInterna) alertar('presenca', 'atencao', 'Presença interna elevada', `${investidoresInternos} de ${cotistas} cotistas podem ser fundos monitorados, conforme posições diretas.`, 'Confirmar identificação no passivo e estudar simplificação.');
      if (!dataXml || dataXml < data || (dataPl != null && dataPl < data) || internas.some(e => dataIsoEstrutura(nos.get(e.source)?.dataCarteira ?? '') !== dataPl)) alertar('datas', 'dados', 'Dados de datas distintas ou carteira ausente', 'A posição, o PL ou a contagem não coincidem com a referência.', 'Validar as datas nas evidências; a relevância pode ser aproximada.');
      const dominante = item.saidas.find(e => e.peso >= limites.intermediario && e.peso <= 1.001);
      if (dominante && item.saidas.reduce((s, e) => s + e.peso, 0) <= 1.05) alertar('intermediario', 'atencao', 'Possível veículo intermediário', `${(dominante.peso * 100).toFixed(2)}% do PL em ${nos.get(dominante.target)?.nome}.`, 'Avaliar finalidade, custos e restrições antes de incorporar ou encerrar.');
      if (!perfil) alertar('cadastro', 'dados', 'Cadastro não localizado', 'Gestor e administrador podem estar disponíveis apenas no XML.', 'Atualizar Fundos — Características.');
    }
    const entidades = entidadesContraparte(no);
    for (const entidade of entidades) {
      const registro = ultimoRegistroEstrutura(registros, `cnpj:${entidade.cnpj}`, 'contraparte', data);
      if (registro && registro.status !== 'sem_restricao') alertar(`contraparte:${entidade.cnpj}`, 'critico', `${entidade.papel}: ${registro.status === 'liquidacao' ? 'liquidação' : registro.status === 'recuperacao' ? 'recuperação' : 'intervenção'}`, `${registro.nota} Fonte: ${registro.fonte}. Referência: ${registro.data_referencia}.`, 'Validar a exposição e acionar a equipe responsável.');
    }
    if (entidades.length === 0 || entidades.some(e => !ultimoRegistroEstrutura(registros, `cnpj:${e.cnpj}`, 'contraparte', data))) alertar('contraparte_cobertura', 'dados', 'Contraparte sem avaliação registrada', 'Ausência de apontamento não comprova ausência de risco.', 'Registrar a situação documentada e sua fonte.');
    itens.set(key, item);
  }
  // Convergência em DAG: múltiplos investidores diretos indicam caminhos distintos;
  // tranches do mesmo investidor foram consolidadas anteriormente.
  const descendentesPorNo = new Map<string, Set<string>>();
  for (const item of itens.values()) {
    const pais = item.entradas.filter(e => alcance.has(e.source));
    if (pais.length > 1) item.alertas.push({ codigo: 'repetido', severidade: 'atencao', titulo: item.no.tipo === 'fundo' ? 'Fundo compartilhado' : 'Ativo repetido', evidencia: `${pais.length} fundos da rede investem neste mesmo destino.`, acao: 'Comparar os caminhos e consolidar a exposição sem somar veículos e ativos finais.' });
    // Busca limitada por arestas e caminho: ciclos não entram em recursão infinita.
    let visitas = 0;
    let ciclo = false;
    let truncado = false;
    const descendentes = new Set<string>();
    const visitar = (key: string, caminho: Set<string>, nivel: number): number => {
      if (caminho.has(key)) { ciclo = true; return nivel; }
      if (++visitas > 5000 || nivel >= 12) { truncado = true; return nivel; }
      const prox = new Set(caminho); prox.add(key);
      let max = nivel;
      for (const e of saidas.get(key) ?? []) {
        if (e.target !== item.no.key) descendentes.add(e.target);
        max = Math.max(max, visitar(e.target, prox, nivel + 1));
      }
      return max;
    };
    item.profundidade = visitar(item.no.key, new Set(), 0);
    if (item.profundidade >= limites.profundidade) item.alertas.push({ codigo: 'profundidade', severidade: 'atencao', titulo: 'Estrutura profunda', evidencia: `${truncado ? 'Pelo menos ' : ''}${item.profundidade} níveis de investimento encontrados.`, acao: 'Investigar veículos entre o fundo e a exposição final.' });
    if (ciclo) item.alertas.push({ codigo: 'ciclo', severidade: 'atencao', titulo: 'Participação circular', evidencia: 'Um caminho retorna a um fundo já visitado.', acao: 'Conciliar a participação cruzada antes de consolidar exposições.' });
    if (truncado) item.alertas.push({ codigo: 'limite', severidade: 'dados', titulo: 'Exploração analítica limitada', evidencia: 'Limite de 12 níveis ou 5.000 visitas atingido; a análise pode ser parcial.', acao: 'Explorar o ramo separadamente.' });
    // Propagação calculada depois que todos os alertas diretos estiverem prontos.
    descendentesPorNo.set(item.no.key, descendentes);
  }
  const origensPorNo = new Map<string, Set<string>>();
  for (const raiz of principais) {
    let visitasOrigem = 0;
    const walkOrigem = (key: string, depth: number, caminho: Set<string>) => {
      if (caminho.has(key) || ++visitasOrigem > 5000 || depth > 12) return;
      const destino = itens.get(key);
      if (!destino) return;
      destino.minDepthOrigem = destino.minDepthOrigem == null ? depth : Math.min(destino.minDepthOrigem, depth);
      destino.maxDepthOrigem = destino.maxDepthOrigem == null ? depth : Math.max(destino.maxDepthOrigem, depth);
      destino.nCaminhosOrigem += 1;
      const set = origensPorNo.get(key) ?? new Set<string>();
      set.add(raiz.key);
      origensPorNo.set(key, set);
      const prox = new Set(caminho);
      prox.add(key);
      for (const e of saidas.get(key) ?? []) walkOrigem(e.target, depth + 1, prox);
    };
    walkOrigem(raiz.key, 0, new Set());
  }
  for (const [key, set] of origensPorNo) {
    const item = itens.get(key);
    if (item) item.nEstruturasOrigem = set.size;
  }
  for (const item of itens.values()) {
    if (item.maxDepthOrigem != null && item.maxDepthOrigem >= limites.profundidade && item.minDepthOrigem != null && item.minDepthOrigem > 0) {
      item.alertas.push({
        codigo: 'acesso_profundo',
        severidade: 'atencao',
        titulo: 'Acesso profundo',
        evidencia: `Há caminhos de ${item.minDepthOrigem} a ${item.maxDepthOrigem} níveis até este destino.`,
        acao: 'Abrir os caminhos e verificar se os veículos intermediários ainda se justificam.',
      });
    }
    if (item.nEstruturasOrigem > 1) {
      const jaRepetido = item.alertas.some(a => a.codigo === 'repetido');
      if (!jaRepetido) {
        item.alertas.push({
          codigo: 'repetido',
          severidade: 'atencao',
          titulo: item.no.tipo === 'fundo' ? 'Fundo compartilhado' : 'Ativo repetido',
          evidencia: `O mesmo destino aparece em ${item.nEstruturasOrigem} estruturas monitoradas.`,
          acao: 'Comparar os caminhos e consolidar a exposição sem somar veículos e ativos finais.',
        });
      }
    }
  }
  for (const item of itens.values()) {
    const descendentes = descendentesPorNo.get(item.no.key)!;
    const herdados = [...descendentes].flatMap(key => itens.get(key)?.alertas ?? []).filter(a => a.severidade !== 'dados');
    item.alertasDescendentes = herdados.length;
    item.motivosScore = pontuarAlertas(item.alertas);
    item.scoreAtencao = Math.min(100, item.motivosScore.reduce((s, m) => s + m.pontos, 0));
    item.prioridade = Math.max(0, ...[...item.alertas, ...herdados].map(a => a.severidade === 'critico' ? 3 : a.severidade === 'atencao' ? 2 : 1));
  }
  const concentrar = (campo: 'gestor' | 'administrador'): ConcentracaoEstrutura[] => {
    const fundos = [...itens.values()].filter(i => i.no.tipo === 'fundo');
    const grupos = new Map<string, { nome: string; fundos: string[] }>();
    for (const item of fundos) {
      const nome = (campo === 'gestor' ? item.perfil?.gestor_principal ?? item.no.gestorNome : item.perfil?.administrador ?? item.no.administradorNome)?.trim() || 'Não identificado';
      const id = normalizarBuscaEstrutura(nome);
      const g = grupos.get(id) ?? { nome, fundos: [] }; g.fundos.push(item.no.key); grupos.set(id, g);
    }
    return [...grupos.values()].map(g => ({ ...g, percentual: g.fundos.length / (fundos.length || 1), alerta: g.nome !== 'Não identificado' && g.fundos.length / fundos.length >= limites.concentracao })).sort((a, b) => b.fundos.length - a.fundos.length);
  };
  return {
    itens,
    principais: principais.map(n => itens.get(n.key)!).sort(ordenarPrioridadeEstrutura),
    gestores: concentrar('gestor'),
    administradores: concentrar('administrador'),
    data,
    resumo: resumirAnaliseEstrutura(itens, ligacoes.length),
  };
}
export function ordenarPrioridadeEstrutura(a: ItemEstrutura, b: ItemEstrutura) {
  return b.prioridade - a.prioridade || (b.relevancia ?? -1) - (a.relevancia ?? -1) || a.no.nome.localeCompare(b.no.nome);
}
export function ordenarScoreAtencao(a: ItemEstrutura, b: ItemEstrutura) {
  return b.scoreAtencao - a.scoreAtencao || ordenarPrioridadeEstrutura(a, b);
}

/** Valor do primeiro investimento × pesos dos ramos seguintes; não soma PLs em cascata. */
export function exposicaoNoCaminho(analise: AnaliseEstrutura, caminho: string[]): number | null {
  if (caminho.length < 2 || new Set(caminho).size !== caminho.length) return null;
  let valor: number | null = null;
  for (let i = 1; i < caminho.length; i++) {
    const aresta = analise.itens.get(caminho[i - 1])?.saidas.find(e => e.target === caminho[i]);
    if (!aresta || aresta.valor == null || aresta.peso <= 0 || aresta.peso > 1.001) return null;
    valor = i === 1 ? aresta.valor : valor! * aresta.peso;
  }
  return valor;
}

/** Produto das participações do caminho (look-through). Primeiro salto usa peso da relação. */
export function pesoEfetivoCaminho(analise: AnaliseEstrutura, caminho: string[]): number | null {
  if (caminho.length < 2 || new Set(caminho).size !== caminho.length) return null;
  let peso = 1;
  for (let i = 1; i < caminho.length; i++) {
    const aresta = analise.itens.get(caminho[i - 1])?.saidas.find(e => e.target === caminho[i]);
    if (!aresta || aresta.peso <= 0 || aresta.peso > 1.001) return null;
    peso *= aresta.peso;
  }
  return peso;
}
