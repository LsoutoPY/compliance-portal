import type { LucideIcon } from "lucide-react";
import {
  Settings,
  Upload,
  Database,
  ShieldAlert,
  ListChecks,
  BarChart3,
  LayoutGrid,
  Droplets,
  Table2,
  LayoutDashboard,
  FileText,
  Receipt,
  CircleDollarSign,
  ClipboardList,
  TrendingDown,
  ShieldCheck,
  TrendingUp,
  LineChart,
  Users,
  BookOpen,
  ShieldOff,
  Clock,
  Gauge,
  Search,
  SlidersHorizontal,
  Network,
  ArrowLeftRight,
  Mail,
  Library,
  Layers,
  FileCheck2,
  GitCompare,
} from "lucide-react";

export type UserAccessType = "completo" | "consulta";

export type NavItemDef = {
  /** Identificador estável — usado em user_menu_permissions no Supabase */
  key: string;
  section: string;
  label: string;
  path: string;
  icon: LucideIcon;
  /** Rotas filhas que herdam a mesma permissão */
  matchPaths?: string[];
  /** Operações de escrita — ocultar para consulta mesmo com menu liberado */
  writeOnly?: boolean;
};

export type HubModuleDef = {
  id: string;
  menuKey: string;
  title: string;
  description: string;
  icon: LucideIcon;
  path: string;
  color: string;
  bgGradient: string;
  status: "active" | "coming_soon" | "disabled";
};

/** Catálogo único de itens da Sidebar (fonte da verdade para menu_key) */
export const NAV_REGISTRY: NavItemDef[] = [
  {
    key: "relatorios.risco-consolidado",
    section: "Relatórios & Compliance",
    label: "Monitoramento de Desenquadramentos",
    path: "/relatorios/risco",
    icon: FileCheck2,
  },
  // Enquadramento
  {
    key: "enquadramento.dashboard",
    section: "Enquadramento",
    label: "Dashboard",
    path: "/enquadramento/dashboard",
    icon: BarChart3,
  },
  {
    key: "enquadramento.monitoramento",
    section: "Enquadramento",
    label: "Monitoramento",
    path: "/enquadramento/monitoramento",
    icon: ShieldCheck,
    matchPaths: ["/enquadramento/carteira"],
  },
  {
    key: "enquadramento.regras",
    section: "Enquadramento",
    label: "Regras",
    path: "/enquadramento/regras",
    icon: ListChecks,
    writeOnly: true,
  },
  {
    key: "enquadramento.regras-relacionais",
    section: "Enquadramento",
    label: "Regras Relacionais",
    path: "/enquadramento/regras-relacionais",
    icon: ShieldAlert,
    writeOnly: true,
  },
  {
    key: "enquadramento.grupos-economicos",
    section: "Enquadramento",
    label: "Grupos Econômicos",
    path: "/enquadramento/grupos-economicos",
    icon: Users,
    writeOnly: true,
  },
  {
    key: "enquadramento.relatorios",
    section: "Enquadramento",
    label: "Relatórios",
    path: "/enquadramento/relatorios",
    icon: ClipboardList,
  },
  // Risco de Liquidez
  {
    key: "liquidez.monitoramento",
    section: "Risco de Liquidez",
    label: "Monitoramento",
    path: "/liquidez/monitoramento-fundo",
    icon: Droplets,
    matchPaths: ["/liquidez/monitoramento-fundo"],
  },
  {
    key: "liquidez.passivo-fundos",
    section: "Risco de Liquidez",
    label: "Passivo Fundos",
    path: "/liquidez/passivo-fundos",
    icon: FileText,
  },
  {
    key: "liquidez.matriz-anbima",
    section: "Risco de Liquidez",
    label: "Matriz ANBIMA",
    path: "/liquidez/matriz-anbima",
    icon: Table2,
  },
  {
    key: "liquidez.resgates-solicitados",
    section: "Risco de Liquidez",
    label: "Resgates Solicitados",
    path: "/liquidez/resgates-solicitados",
    icon: Receipt,
  },
  {
    key: "liquidez.descasamento-operacional",
    section: "Risco de Liquidez",
    label: "Descasamento Operacional",
    path: "/liquidez/descasamento-operacional",
    icon: ArrowLeftRight,
  },
  {
    key: "liquidez.relatorios",
    section: "Risco de Liquidez",
    label: "Relatórios",
    path: "/liquidez/relatorios",
    icon: ClipboardList,
  },
  // Risco de Crédito
  {
    key: "credito.matriz",
    section: "Risco de Crédito",
    label: "Monitoramento",
    path: "/credito/matriz",
    icon: LayoutGrid,
    matchPaths: [
      "/credito/dashboard",
      "/credito/monitoramento",
      "/credito/consolidado",
      "/credito/safras",
    ],
  },
  {
    key: "credito.rollrate",
    section: "Risco de Crédito",
    label: "Roll Rate / Migração",
    path: "/credito/rollrate",
    icon: TrendingDown,
  },
  {
    key: "credito.elegibilidade",
    section: "Risco de Crédito",
    label: "Elegibilidade",
    path: "/credito/elegibilidade",
    icon: ShieldCheck,
  },
  {
    key: "credito.cadastro-partes",
    section: "Risco de Crédito",
    label: "Cadastro Partes",
    path: "/credito/cadastro-partes",
    icon: Users,
    writeOnly: true,
  },
  {
    key: "credito.estoque",
    section: "Risco de Crédito",
    label: "Estoque FIDC",
    path: "/credito/estoque",
    icon: Database,
  },
  {
    key: "credito.importar",
    section: "Risco de Crédito",
    label: "Importar Estoque",
    path: "/credito/importar",
    icon: Upload,
    writeOnly: true,
  },
  // Gestão de Crédito
  {
    key: "gestao-credito.cardapio",
    section: "Gestão de Crédito",
    label: "Cardápio de Ativos",
    path: "/gestao-credito/cardapio",
    icon: BookOpen,
  },
  {
    key: "gestao-credito.aquisicao",
    section: "Gestão de Crédito",
    label: "Nova Aquisição (P1)",
    path: "/gestao-credito/aquisicao",
    icon: ShieldCheck,
    writeOnly: true,
  },
  {
    key: "gestao-credito.monitoramento",
    section: "Gestão de Crédito",
    label: "Monitoramento (P4)",
    path: "/gestao-credito/monitoramento",
    icon: Clock,
  },
  {
    key: "gestao-credito.desenquadramentos",
    section: "Gestão de Crédito",
    label: "Desenquadramentos (P5)",
    path: "/gestao-credito/desenquadramentos",
    icon: ShieldOff,
  },
  // Stress Testing
  {
    key: "stress-testing.painel",
    section: "Stress Testing",
    label: "Painel",
    path: "/stress-testing/painel",
    icon: Gauge,
  },
  {
    key: "stress-testing.auditoria",
    section: "Stress Testing",
    label: "Auditoria",
    path: "/stress-testing/auditoria",
    icon: Search,
  },
  {
    key: "stress-testing.betas-fundo",
    section: "Stress Testing",
    label: "Betas",
    path: "/stress-testing/betas-fundo",
    icon: LineChart,
  },
  {
    key: "stress-testing.configuracao",
    section: "Stress Testing",
    label: "Configuração",
    path: "/stress-testing/configuracao",
    icon: SlidersHorizontal,
    writeOnly: true,
  },
  {
    key: "stress-testing.stop-loss",
    section: "Stress Testing",
    label: "Stop Loss",
    path: "/stress-testing/stop-loss",
    icon: TrendingDown,
  },
  // Risco de Mercado
  {
    key: "risco-mercado.var",
    section: "Risco de Mercado",
    label: "VaR por Carteira",
    path: "/risco-mercado",
    icon: ShieldAlert,
    matchPaths: ["/risco-mercado"],
  },
  {
    key: "risco-mercado.relatorios",
    section: "Risco de Mercado",
    label: "Relatórios",
    path: "/risco-mercado/relatorios",
    icon: ClipboardList,
  },
  // Controle Cotas
  {
    key: "controle-cotas.dashboard",
    section: "Controle Cotas",
    label: "Controle Cotas Carteiras",
    path: "/controle-cotas/dashboard",
    icon: TrendingUp,
  },
  {
    key: "controle-cotas.rentabilidade",
    section: "Controle Cotas",
    label: "Rentabilidade fundos",
    path: "/controle-cotas/rentabilidade",
    icon: LineChart,
    matchPaths: ["/controle-cotas/rentabilidade"],
  },
  {
    key: "controle-cotas.conciliacao",
    section: "Controle Cotas",
    label: "Conciliação",
    path: "/controle-cotas/conciliacao",
    icon: GitCompare,
  },
  {
    key: "controle-cotas.enviar-relatorio",
    section: "Controle Cotas",
    label: "Enviar Relatório",
    path: "/controle-cotas/enviar-relatorio",
    icon: Mail,
    writeOnly: true,
  },
  // Dados
  {
    key: "dados.consolidado-xml",
    section: "Dados",
    label: "Dashboard de XMLs",
    path: "/liquidez/consolidado",
    icon: LayoutDashboard,
  },
  {
    key: "dados.importar-xml",
    section: "Dados",
    label: "Importar XML",
    path: "/enquadramento/importar",
    icon: Upload,
    writeOnly: true,
  },
  {
    key: "dados.ativos",
    section: "Dados",
    label: "Cardápio de Ativos",
    path: "/enquadramento/ativos",
    icon: Database,
    writeOnly: true,
  },
  {
    key: "dados.posicao-fundos",
    section: "Dados",
    label: "Posição Fundos",
    path: "/dados/posicao-fundos",
    icon: Table2,
    matchPaths: ["/dados/posicao-fundos"],
  },
  {
    key: "dados.mapa-ativos",
    section: "Dados",
    label: "Mapa de Ativos",
    path: "/dados/mapa-ativos",
    icon: Network,
  },
  {
    key: "dados.controle-taxas",
    section: "Dados",
    label: "Controle de Taxas",
    path: "/dados/controle-taxas",
    icon: CircleDollarSign,
    writeOnly: true,
  },
  {
    key: "dados.gestores-monitorados",
    section: "Dados",
    label: "Gestores Monitorados",
    path: "/dados/gestores-monitorados",
    icon: ShieldCheck,
    writeOnly: true,
  },
  // Documentação
  {
    key: "manuais",
    section: "Documentação",
    label: "Manuais",
    path: "/manuais",
    icon: Library,
  },
];

/** Rotas legadas que redirecionam — mapeadas para permissão de destino */
export const LEGACY_ROUTE_MENU_KEYS: Record<string, string> = {
  "/dashboard": "enquadramento.dashboard",
  "/enquadramentos": "enquadramento.monitoramento",
  "/enquadramento": "enquadramento.dashboard",
  "/importar": "dados.importar-xml",
  "/ativos": "dados.ativos",
  "/regras": "enquadramento.regras",
  "/regras-relacionais": "enquadramento.regras-relacionais",
  "/liquidez": "liquidez.monitoramento",
  "/credito": "credito.matriz",
  "/credito/dashboard": "credito.matriz",
  "/credito/monitoramento": "credito.matriz",
  "/credito/consolidado": "credito.matriz",
  "/credito/safras": "credito.matriz",
  "/controle-cotas": "controle-cotas.dashboard",
  "/gestao-credito": "gestao-credito.cardapio",
  "/stress-testing": "stress-testing.painel",
  "/dados/mapa-fundos": "dados.mapa-ativos",
  "/dados/mapa_fundos": "dados.mapa-ativos",
};

export const HUB_MODULES: HubModuleDef[] = [
  {
    id: "enquadramento",
    menuKey: "enquadramento.dashboard",
    title: "Enquadramento de Fundos",
    description:
      "Monitoramento de compliance, verificação de regras de investimento e controle de enquadramento de carteiras.",
    icon: ShieldCheck,
    path: "/enquadramento",
    color: "text-emerald-600",
    bgGradient: "from-emerald-500/10 to-emerald-600/5",
    status: "active",
  },
  {
    id: "liquidez",
    menuKey: "liquidez.monitoramento",
    title: "Risco de Liquidez",
    description:
      "Análise e monitoramento de risco de liquidez das carteiras, Matriz ANBIMA e projeções de fluxo de caixa.",
    icon: Droplets,
    path: "/liquidez/monitoramento-fundo",
    color: "text-blue-600",
    bgGradient: "from-blue-500/10 to-blue-600/5",
    status: "active",
  },
  {
    id: "credito",
    menuKey: "credito.matriz",
    title: "Risco de Crédito",
    description:
      "Monitoramento de aging, buckets de atraso, PDD atual vs metodológica e indicadores de risco para FIDC.",
    icon: CircleDollarSign,
    path: "/credito/matriz",
    color: "text-violet-600",
    bgGradient: "from-violet-500/10 to-violet-600/5",
    status: "active",
  },
  {
    id: "controle-cotas",
    menuKey: "controle-cotas.dashboard",
    title: "Controle Cotas",
    description:
      "Importação diária de cotas por cliente, consolidação de série histórica e cálculo de métricas de risco: retorno logarítmico, desvio padrão, alerta 3σ e VaR mensal 95%.",
    icon: TrendingUp,
    path: "/controle-cotas/dashboard",
    color: "text-amber-600",
    bgGradient: "from-amber-500/10 to-amber-600/5",
    status: "active",
  },
  {
    id: "stress-testing",
    menuKey: "stress-testing.painel",
    title: "Stress Testing",
    description:
      "Monitoramento diário de risco de perda das carteiras. Simula choques de mercado (CDI, Ibovespa, Dólar, S&P 500, IMA-B) e verifica se carteiras ultrapassam limites contratuais.",
    icon: Gauge,
    path: "/stress-testing/painel",
    color: "text-rose-600",
    bgGradient: "from-rose-500/10 to-rose-600/5",
    status: "active",
  },
  {
    id: "risco-mercado",
    menuKey: "risco-mercado.var",
    title: "Risco de Mercado",
    description:
      "VaR Histórico 21d por carteira e por fundo. Exibe Drawdown Atual, Drawdown Máx 252d, Pior 21d e Stress Pior para carteiras; VaR 95%/99%, Drawdown e Qualidade para fundos importados via XML.",
    icon: BarChart3,
    path: "/risco-mercado",
    color: "text-indigo-600",
    bgGradient: "from-indigo-500/10 to-indigo-600/5",
    status: "active",
  },
];

/** Item fixo da sidebar (sempre visível para usuários ativos) */
export const SIDEBAR_HUB_ITEM = {
  key: "hub",
  label: "Voltar ao Hub",
  path: "/",
  icon: LayoutGrid,
};

/** Configurações — hub (somente perfil completo) */
export const SIDEBAR_SETTINGS_ITEM = {
  key: "configuracoes.hub",
  label: "Configurações",
  path: "/configuracoes",
  icon: Settings,
};

function normalizePath(pathname: string): string {
  const base = pathname.split("?")[0].replace(/\/$/, "") || "/";
  return base;
}

function pathMatches(normalizedPath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\/$/, "") || "/";
  if (normalizedPath === normalizedPattern) return true;
  if (normalizedPattern !== "/" && normalizedPath.startsWith(`${normalizedPattern}/`)) {
    return true;
  }
  return false;
}

/** Resolve o menu_key a partir do pathname atual */
export function resolveMenuKeyFromPath(pathname: string): string | null {
  const normalized = normalizePath(pathname);

  if (normalized === "/") return "hub";
  if (normalized === "/login") return null;
  if (normalized.startsWith("/conta")) return "conta";
  if (normalized.startsWith("/esqueci-senha") || normalized.startsWith("/redefinir-senha")) {
    return null;
  }
  if (normalized.startsWith("/configuracoes/monitoramento")) return "configuracoes.monitoramento";
  if (normalized.startsWith("/configuracoes/usuarios")) return "configuracoes.usuarios";
  if (normalized.startsWith("/configuracoes/notificacoes")) return "configuracoes.notificacoes";
  if (normalized.startsWith("/configuracoes")) return "configuracoes.hub";

  if (LEGACY_ROUTE_MENU_KEYS[normalized]) {
    return LEGACY_ROUTE_MENU_KEYS[normalized];
  }

  for (const item of NAV_REGISTRY) {
    if (pathMatches(normalized, item.path)) return item.key;
    for (const match of item.matchPaths ?? []) {
      if (pathMatches(normalized, match)) return item.key;
    }
  }

  // /carteira/:cnpj (retrocompat)
  if (normalized.startsWith("/carteira/")) {
    return "enquadramento.monitoramento";
  }

  return null;
}

export function getNavItemByKey(key: string): NavItemDef | undefined {
  return NAV_REGISTRY.find((item) => item.key === key);
}

/** Agrupa itens visíveis por seção, preservando ordem do registry */
export function groupNavItemsBySection(items: NavItemDef[]): { section: string; items: NavItemDef[] }[] {
  const sections: { section: string; items: NavItemDef[] }[] = [];
  const indexBySection = new Map<string, number>();

  for (const item of items) {
    const idx = indexBySection.get(item.section);
    if (idx === undefined) {
      indexBySection.set(item.section, sections.length);
      sections.push({ section: item.section, items: [item] });
    } else {
      sections[idx].items.push(item);
    }
  }

  return sections;
}
