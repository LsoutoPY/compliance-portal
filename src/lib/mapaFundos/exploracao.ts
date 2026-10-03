/**
 * Exploração de fundos — caminhos, look-through e filtros.
 *
 * Premissas (evitar dupla contagem):
 * 1. Relevância consolidada = soma das posições DIRETAS dos fundos monitorados / PL do alvo.
 *    Não usa look-through. Tranches do mesmo investidor já foram agrupadas em `entradas`.
 * 2. Exposição de um caminho = valor do 1º salto × pesos dos saltos seguintes.
 *    Não soma o PL dos veículos intermediários.
 * 3. Soma bruta de caminhos pode sobrepor valor quando dois caminhos compartilham
 *    um veículo intermediário. Nesse caso `possivelSobreposicao` fica verdadeiro
 *    e a UI deve mostrar os caminhos, não um total único como se fosse exposição econômica.
 * 4. Agregação por fundo de origem soma caminhos que partem daquele fundo.
 *    Isso é adequado quando os ramos seguintes são alocações distintas da mesma posição.
 *    Continua podendo sobrepor se houver diamante no meio da cadeia.
 * 5. Ciclos são cortados (visited no caminho). Caminho com ciclo não entra no look-through.
 */

import {
  correspondeBuscaEstrutura,
  exposicaoNoCaminho,
  LIMITES_ESTRUTURA,
  ordenarScoreAtencao,
  origemInformeDiario,
  origemInformeMensal,
  pesoEfetivoCaminho,
  type AnaliseEstrutura,
  type ItemEstrutura,
  type LigacaoEstrutura,
} from './estrutura';

export const LIMITE_CAMINHOS = 40;
export const LIMITE_VISITAS_CAMINHO = 4000;
/** Profundidade máxima ao explodir a árvore (look-through completo, com corte de ciclo). */
export const PROFUNDIDADE_MAX_ARVORE = 16;
export const SAIDAS_TODAS = 999;
export const LIMITE_NOS_ESTRUTURA = 180;
export const CARD_ESTRUTURA = { w: 176, h: 86, gapX: 96, gapY: 16, pad: 36 };

export interface NoGrafoEstrutura {
  key: string;
  item: ItemEstrutura;
  col: number;
  papel: 'investidor' | 'foco' | 'destino';
}

export interface ArestaGrafoEstrutura {
  source: string;
  target: string;
  peso: number | null;
}

export interface GrafoEstrutura {
  nos: NoGrafoEstrutura[];
  arestas: ArestaGrafoEstrutura[];
}

export function montarGrafoEstrutura(
  analise: AnaliseEstrutura,
  raizKeys: string[],
  maxProfundidade = PROFUNDIDADE_MAX_ARVORE,
  mostrarAtivos = true,
): GrafoEstrutura {
  const byKey = new Map<string, NoGrafoEstrutura>();
  const arestas: ArestaGrafoEstrutura[] = [];
  const vistoAresta = new Set<string>();
  const addNo = (item: ItemEstrutura, col: number, papel: NoGrafoEstrutura['papel']) => {
    const atual = byKey.get(item.no.key);
    if (!atual) byKey.set(item.no.key, { key: item.no.key, item, col, papel });
    else if (col < atual.col) atual.col = col;
  };
  const addAresta = (source: string, target: string, peso: number | null) => {
    const id = `${source}>${target}`;
    if (vistoAresta.has(id)) return;
    vistoAresta.add(id);
    arestas.push({ source, target, peso });
  };

  const focado = raizKeys.length === 1;
  const colRaiz = focado ? 1 : 0;
  for (const key of raizKeys) {
    const item = analise.itens.get(key);
    if (item) addNo(item, colRaiz, 'foco');
  }
  if (focado) {
    for (const { lig, item } of investidoresDoNo(analise, raizKeys[0])) {
      addNo(item, 0, 'investidor');
      addAresta(item.no.key, raizKeys[0], lig.peso);
    }
  }

  const fila: { key: string; depth: number }[] = raizKeys.map(key => ({ key, depth: 0 }));
  const enfileirado = new Set(raizKeys);
  let guard = 0;
  while (fila.length && byKey.size < LIMITE_NOS_ESTRUTURA && guard++ < 8_000) {
    const atual = fila.shift()!;
    if (atual.depth >= maxProfundidade) continue;
    const item = analise.itens.get(atual.key);
    if (!item) continue;
    const origem = byKey.get(atual.key);
    if (!origem) continue;
    for (const s of item.saidas) {
      const filho = analise.itens.get(s.target);
      if (!filho) continue;
      if (!mostrarAtivos && filho.no.tipo === 'ativo') continue;
      if (s.target === atual.key) continue;
      addNo(filho, origem.col + 1, 'destino');
      addAresta(atual.key, filho.no.key, s.peso);
      if (!enfileirado.has(filho.no.key)) {
        enfileirado.add(filho.no.key);
        fila.push({ key: filho.no.key, depth: atual.depth + 1 });
      }
    }
  }
  return { nos: [...byKey.values()], arestas };
}

export function layoutColunasEstrutura(nos: NoGrafoEstrutura[]): Map<string, { x: number; y: number }> {
  const cols = new Map<number, NoGrafoEstrutura[]>();
  for (const n of nos) {
    const list = cols.get(n.col) ?? [];
    list.push(n);
    cols.set(n.col, list);
  }
  const pos = new Map<string, { x: number; y: number }>();
  [...cols.keys()].sort((a, b) => a - b).forEach((col, i) => {
    const list = (cols.get(col) ?? []).sort((a, b) => {
      if (a.papel !== b.papel) return a.papel === 'foco' ? -1 : b.papel === 'foco' ? 1 : a.papel.localeCompare(b.papel);
      return (b.item.scoreAtencao - a.item.scoreAtencao) || a.item.no.nome.localeCompare(b.item.no.nome, 'pt-BR');
    });
    list.forEach((n, row) => {
      pos.set(n.key, {
        x: CARD_ESTRUTURA.pad + i * (CARD_ESTRUTURA.w + CARD_ESTRUTURA.gapX),
        y: CARD_ESTRUTURA.pad + row * (CARD_ESTRUTURA.h + CARD_ESTRUTURA.gapY),
      });
    });
  });
  return pos;
}

export function tamanhoGrafoEstrutura(pos: Map<string, { x: number; y: number }>): { w: number; h: number } {
  let maxX = CARD_ESTRUTURA.w;
  let maxY = CARD_ESTRUTURA.h;
  for (const p of pos.values()) {
    maxX = Math.max(maxX, p.x + CARD_ESTRUTURA.w);
    maxY = Math.max(maxY, p.y + CARD_ESTRUTURA.h);
  }
  return { w: maxX + CARD_ESTRUTURA.pad, h: maxY + CARD_ESTRUTURA.pad };
}

export interface CaminhoExploracao {
  nos: string[];
  exposicao: number | null;
  pesoEfetivo: number | null;
}

export interface AgregacaoCaminhos {
  bruta: number | null;
  porOrigem: { origem: string; valor: number | null }[];
  possivelSobreposicao: boolean;
  premissa: string;
}

export interface OcorrenciaEstrutura {
  origemKey: string;
  origemNome: string;
  profundidade: number;
}

export interface FiltroExploracao {
  busca: string;
  soAlerta: boolean;
  soCompartilhados: boolean;
  relevanciaMin: number;
  profundidadeMin: number | null;
  mostrarAtivos: boolean;
  tipo: 'todos' | 'fundo' | 'ativo' | 'fidc' | 'fip';
  gestor: string;
  administrador: string;
}

export const FILTRO_EXPLORACAO_INICIAL: FiltroExploracao = {
  busca: '',
  soAlerta: false,
  soCompartilhados: false,
  relevanciaMin: 0,
  profundidadeMin: null,
  mostrarAtivos: true,
  tipo: 'todos',
  gestor: '',
  administrador: '',
};

export function encontrarCaminhosAte(
  analise: AnaliseEstrutura,
  destino: string,
  origens?: string[],
  maxCaminhos = LIMITE_CAMINHOS,
): CaminhoExploracao[] {
  if (!analise.itens.has(destino)) return [];
  const raizes = origens?.length
    ? origens.filter(k => analise.itens.has(k))
    : analise.principais.map(p => p.no.key);
  const encontrados: CaminhoExploracao[] = [];
  let visitas = 0;

  const walk = (path: string[]) => {
    if (encontrados.length >= maxCaminhos || ++visitas > LIMITE_VISITAS_CAMINHO) return;
    const atual = path[path.length - 1];
    if (atual === destino) {
      if (path.length >= 2) {
        encontrados.push({
          nos: [...path],
          exposicao: exposicaoNoCaminho(analise, path),
          pesoEfetivo: pesoEfetivoCaminho(analise, path),
        });
      }
      return;
    }
    const item = analise.itens.get(atual);
    if (!item) return;
    for (const e of item.saidas) {
      if (path.includes(e.target)) continue;
      walk([...path, e.target]);
    }
  };

  for (const raiz of raizes) {
    if (raiz === destino) continue;
    walk([raiz]);
  }

  return encontrados.sort((a, b) => (b.exposicao ?? -1) - (a.exposicao ?? -1));
}

export function encontrarCaminhosDesde(
  analise: AnaliseEstrutura,
  origem: string,
  maxCaminhos = LIMITE_CAMINHOS,
): CaminhoExploracao[] {
  const start = analise.itens.get(origem);
  if (!start) return [];
  const encontrados: CaminhoExploracao[] = [];
  let visitas = 0;

  const walk = (path: string[]) => {
    if (encontrados.length >= maxCaminhos || ++visitas > LIMITE_VISITAS_CAMINHO) return;
    const atual = path[path.length - 1];
    const item = analise.itens.get(atual);
    if (!item) return;
    const proximos = item.saidas.filter(e => !path.includes(e.target));
    if (!proximos.length) {
      if (path.length >= 2) {
        encontrados.push({
          nos: [...path],
          exposicao: exposicaoNoCaminho(analise, path),
          pesoEfetivo: pesoEfetivoCaminho(analise, path),
        });
      }
      return;
    }
    for (const e of proximos) walk([...path, e.target]);
  };

  walk([origem]);
  return encontrados.sort((a, b) => (b.exposicao ?? -1) - (a.exposicao ?? -1));
}

export function agregarExposicaoCaminhos(caminhos: CaminhoExploracao[]): AgregacaoCaminhos {
  const incompleto = !caminhos.length || caminhos.some(c => c.exposicao == null);
  const bruta = incompleto ? null : caminhos.reduce((s, c) => s + (c.exposicao ?? 0), 0);

  const intermediarios = new Map<string, number>();
  for (const c of caminhos) {
    for (const key of c.nos.slice(1, -1)) {
      intermediarios.set(key, (intermediarios.get(key) ?? 0) + 1);
    }
  }
  const possivelSobreposicao = [...intermediarios.values()].some(n => n > 1);

  const porOrigemMap = new Map<string, number | null>();
  for (const c of caminhos) {
    const origem = c.nos[0];
    const atual = porOrigemMap.get(origem);
    if (c.exposicao == null) {
      porOrigemMap.set(origem, null);
    } else if (porOrigemMap.has(origem) && atual == null) {
      /* origem já marcada como incompleta */
    } else {
      porOrigemMap.set(origem, (atual ?? 0) + c.exposicao);
    }
  }

  const premissa = possivelSobreposicao
    ? 'Há veículos intermediários compartilhados entre caminhos. A soma bruta pode contar o mesmo investimento mais de uma vez — use os caminhos individuais e a relevância direta.'
    : 'Os caminhos não compartilham veículos intermediários. A soma por origem aproxima a exposição look-through, sem somar o PL dos veículos.';

  return {
    bruta: possivelSobreposicao ? null : bruta,
    porOrigem: [...porOrigemMap.entries()].map(([origem, valor]) => ({ origem, valor })),
    possivelSobreposicao,
    premissa,
  };
}

export function ocorrenciasEntidade(analise: AnaliseEstrutura, key: string): OcorrenciaEstrutura[] {
  const item = analise.itens.get(key);
  if (!item) return [];
  const out: OcorrenciaEstrutura[] = [];
  for (const origem of analise.principais) {
    const caminhos = encontrarCaminhosAte(analise, key, [origem.no.key], 8);
    if (origem.no.key === key) {
      out.push({ origemKey: origem.no.key, origemNome: origem.no.nome, profundidade: 0 });
      continue;
    }
    if (!caminhos.length) continue;
    const depths = caminhos.map(c => c.nos.length - 1);
    out.push({
      origemKey: origem.no.key,
      origemNome: origem.no.nome,
      profundidade: Math.min(...depths),
    });
  }
  return out.sort((a, b) => a.profundidade - b.profundidade || a.origemNome.localeCompare(b.origemNome));
}

export function itemCompartilhado(item: ItemEstrutura, analise: AnaliseEstrutura): boolean {
  const entradasRede = item.entradas.filter(e => analise.itens.has(e.source)).length;
  return entradasRede > 1 || item.nEstruturasOrigem > 1;
}

export function gestorItem(item: ItemEstrutura): string {
  return (item.perfil?.gestor_principal || item.no.gestorNome || '').trim();
}

export function administradorItem(item: ItemEstrutura): string {
  return (item.perfil?.administrador || item.no.administradorNome || '').trim();
}

export function tipoCadastroItem(item: ItemEstrutura): string {
  return (item.perfil?.tipo_anbima || item.perfil?.categoria_anbima || item.no.tipo).trim();
}

export function passaFiltroExploracao(item: ItemEstrutura, analise: AnaliseEstrutura, f: FiltroExploracao): boolean {
  if (!correspondeBuscaEstrutura(item, f.busca)) return false;
  if (!f.mostrarAtivos && item.no.tipo === 'ativo') return false;
  if (f.tipo === 'fundo' && item.no.tipo !== 'fundo') return false;
  if (f.tipo === 'ativo' && item.no.tipo !== 'ativo') return false;
  if (f.tipo === 'fidc' && !/fidc/i.test(`${tipoCadastroItem(item)} ${item.no.nome}`)) return false;
  if (f.tipo === 'fip' && !/\bfip\b/i.test(`${tipoCadastroItem(item)} ${item.no.nome}`)) return false;
  if (f.soAlerta && !item.alertas.some(a => a.severidade !== 'dados') && item.prioridade < 2) return false;
  if (f.soCompartilhados && !itemCompartilhado(item, analise)) return false;
  if (f.relevanciaMin > 0 && (item.relevancia == null || item.relevancia < f.relevanciaMin)) return false;
  if (f.profundidadeMin != null && (item.maxDepthOrigem == null || item.maxDepthOrigem < f.profundidadeMin)) return false;
  if (f.gestor && gestorItem(item) !== f.gestor) return false;
  if (f.administrador && administradorItem(item) !== f.administrador) return false;
  return true;
}

export function listarItensFiltrados(analise: AnaliseEstrutura, f: FiltroExploracao): ItemEstrutura[] {
  return [...analise.itens.values()].filter(i => passaFiltroExploracao(i, analise, f)).sort(ordenarScoreAtencao);
}

export function fundosQueExigemAtencao(analise: AnaliseEstrutura, f: FiltroExploracao, limite = 12): ItemEstrutura[] {
  return listarItensFiltrados(analise, f)
    .filter(i => i.no.tipo === 'fundo' && (i.scoreAtencao > 0 || i.prioridade >= 2 || (i.relevancia != null && i.relevancia >= LIMITES_ESTRUTURA.relevancia)))
    .slice(0, limite);
}

export function rankingRelevancia(analise: AnaliseEstrutura, limite = 8): ItemEstrutura[] {
  return [...analise.itens.values()]
    .filter(i => i.no.tipo === 'fundo' && i.relevancia != null)
    .sort((a, b) => (b.relevancia ?? -1) - (a.relevancia ?? -1))
    .slice(0, limite);
}

export function rankingCompartilhados(analise: AnaliseEstrutura, limite = 8): ItemEstrutura[] {
  return [...analise.itens.values()]
    .filter(i => i.no.tipo === 'fundo' && itemCompartilhado(i, analise))
    .sort((a, b) => b.nEstruturasOrigem - a.nEstruturasOrigem || b.investidoresInternos - a.investidoresInternos)
    .slice(0, limite);
}

export function rankingPoucosCotistas(analise: AnaliseEstrutura, limite = 8): ItemEstrutura[] {
  return [...analise.itens.values()]
    .filter(i => i.no.tipo === 'fundo' && i.cotistas != null)
    .sort((a, b) => (a.cotistas ?? 1e9) - (b.cotistas ?? 1e9) || (b.relevancia ?? -1) - (a.relevancia ?? -1))
    .slice(0, limite);
}

export function rankingProfundos(analise: AnaliseEstrutura, limite = 8): ItemEstrutura[] {
  return [...analise.itens.values()]
    .filter(i => (i.maxDepthOrigem ?? 0) > 1)
    .sort((a, b) => (b.maxDepthOrigem ?? 0) - (a.maxDepthOrigem ?? 0) || b.scoreAtencao - a.scoreAtencao)
    .slice(0, limite);
}

export function rankingExposicaoDuplicada(analise: AnaliseEstrutura, limite = 8): ItemEstrutura[] {
  return [...analise.itens.values()]
    .filter(i => i.nCaminhosOrigem > 1)
    .sort((a, b) => b.nCaminhosOrigem - a.nCaminhosOrigem || b.scoreAtencao - a.scoreAtencao)
    .slice(0, limite);
}

export function saidasPrioritarias(
  item: ItemEstrutura,
  analise: AnaliseEstrutura,
  limite = LIMITES_ESTRUTURA.saidasVisiveis,
  mostrarAtivos = true,
): { visiveis: { lig: LigacaoEstrutura; filho: ItemEstrutura }[]; ocultas: number } {
  const filhos = item.saidas
    .map(lig => ({ lig, filho: analise.itens.get(lig.target) }))
    .filter((x): x is { lig: LigacaoEstrutura; filho: ItemEstrutura } => !!x.filho)
    .filter(x => mostrarAtivos || x.filho.no.tipo !== 'ativo')
    .sort((a, b) =>
      b.filho.scoreAtencao - a.filho.scoreAtencao
      || (b.lig.valor ?? -1) - (a.lig.valor ?? -1)
      || (b.lig.peso ?? 0) - (a.lig.peso ?? 0),
    );
  return { visiveis: filhos.slice(0, limite), ocultas: Math.max(0, filhos.length - limite) };
}

export function investidoresDoNo(analise: AnaliseEstrutura, key: string): { lig: LigacaoEstrutura; item: ItemEstrutura }[] {
  const alvo = analise.itens.get(key);
  if (!alvo) return [];
  return alvo.entradas
    .map(lig => ({ lig, item: analise.itens.get(lig.source) }))
    .filter((x): x is { lig: LigacaoEstrutura; item: ItemEstrutura } => !!x.item)
    .sort((a, b) => (b.lig.valor ?? -1) - (a.lig.valor ?? -1) || (b.lig.peso ?? 0) - (a.lig.peso ?? 0));
}

export function explosaoCompleta(
  analise: AnaliseEstrutura,
  raizKeys: string[],
  maxProfundidade = PROFUNDIDADE_MAX_ARVORE,
  mostrarAtivos = true,
): { paths: Set<string>; limites: Map<string, number> } {
  const paths = new Set<string>();
  const limites = new Map<string, number>();
  let visitas = 0;
  const visitar = (path: string[], depth: number) => {
    if (visitas++ > 12_000) return;
    const key = path[path.length - 1];
    const item = analise.itens.get(key);
    if (!item) return;
    const filhos = item.saidas.filter(s => {
      const filho = analise.itens.get(s.target);
      if (!filho) return false;
      if (!mostrarAtivos && filho.no.tipo === 'ativo') return false;
      if (path.includes(s.target)) return false;
      return true;
    });
    if (!filhos.length) return;
    const pk = path.join('|');
    paths.add(pk);
    limites.set(pk, Math.max(filhos.length, SAIDAS_TODAS));
    if (depth >= maxProfundidade) return;
    for (const s of filhos) visitar([...path, s.target], depth + 1);
  };
  for (const raiz of raizKeys) visitar([raiz], 0);
  return { paths, limites };
}

export function caminhoMaisCurto(analise: AnaliseEstrutura, origem: string, destino: string): string[] | null {
  if (origem === destino) return [origem];
  const fila: string[][] = [[origem]];
  const visto = new Set([origem]);
  let guard = 0;
  while (fila.length && guard++ < 8000) {
    const path = fila.shift()!;
    const atual = analise.itens.get(path[path.length - 1]);
    if (!atual) continue;
    for (const e of atual.saidas) {
      if (visto.has(e.target) || path.includes(e.target)) continue;
      const next = [...path, e.target];
      if (e.target === destino) return next;
      visto.add(e.target);
      fila.push(next);
    }
  }
  return null;
}

export function origemParaNavegar(analise: AnaliseEstrutura, destino: string): { origem: string; path: string[] } | null {
  if (!analise.itens.has(destino)) return null;
  let melhor: { origem: string; path: string[] } | null = null;
  for (const raiz of analise.principais) {
    const path = caminhoMaisCurto(analise, raiz.no.key, destino);
    if (!path) continue;
    if (!melhor || path.length < melhor.path.length) melhor = { origem: raiz.no.key, path };
  }
  if (!melhor && analise.itens.get(destino)?.no.tipo === 'fundo') {
    return { origem: destino, path: [destino] };
  }
  return melhor;
}

export function opcoesGestor(analise: AnaliseEstrutura): string[] {
  return [...new Set([...analise.itens.values()].map(gestorItem).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export function opcoesAdministrador(analise: AnaliseEstrutura): string[] {
  return [...new Set([...analise.itens.values()].map(administradorItem).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export function fmtMoeda(v?: number | null): string {
  return v == null ? 'Indisponível' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);
}

export function fmtPct(v?: number | null): string {
  return v == null ? 'Indisponível' : new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
}

/** Curva em cotovelo (Bezier) para ligar fundo → destino na árvore da estrutura. */
export function pathCotoveloEstrutura(x1: number, y1: number, x2: number, y2: number): string {
  const mx = x1 + (x2 - x1) * 0.5;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(x1)} ${r(y1)} C ${r(mx)} ${r(y1)}, ${r(mx)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

export function pontoMedioCotovelo(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  return { x: x1 + (x2 - x1) * 0.5, y: (y1 + y2) / 2 };
}

export function fmtData(v?: string | null): string {
  return v ? v.replace(/^(\d{4})-?(\d{2})-?(\d{2}).*$/, '$3/$2/$1') : 'Indisponível';
}

export function textoScore(score: number): string {
  if (score >= 50) return 'Atenção alta';
  if (score >= 25) return 'Investigar';
  if (score >= 10) return 'Acompanhar';
  return 'Sem sinal de atenção';
}

/** Rótulo da fonte do PL/cotistas usada na matriz (informe diário, mensal ou carteira XML). */
export function rotuloFonte(item: ItemEstrutura): string {
  if (item.fontePl === 'CVM') {
    if (origemInformeDiario(item.metrica?.origem)) return 'Informe Diário';
    if (origemInformeMensal(item.metrica?.origem)) return 'Informe Mensal';
    return 'CVM';
  }
  if (item.fontePl === 'XML') return 'Carteira XML';
  return '—';
}
