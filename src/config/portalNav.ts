export type PortalNavItem = {
  id: string;
  label: string;
  icon: string;
  section?: string;
  path: string;
};

export const PORTAL_NAV: PortalNavItem[] = [
  { id: "importar", label: "Importações", icon: "upload", section: "Dados", path: "/dados/importar" },
  { id: "xml-dashboard", label: "Dashboard de XMLs", icon: "layout-dashboard", section: "Dados", path: "/liquidez/consolidado" },
  { id: "ativos", label: "Cardápio de ativos", icon: "database", section: "Dados", path: "/enquadramento/ativos" },

  { id: "enq-dashboard", label: "Dashboard", icon: "bar-chart-3", section: "Enquadramento", path: "/enquadramento/dashboard" },
  { id: "enq-monitoramento", label: "Monitoramento", icon: "shield-check", section: "Enquadramento", path: "/enquadramento/monitoramento" },
  { id: "enq-regras", label: "Regras", icon: "list-checks", section: "Enquadramento", path: "/enquadramento/regras" },
  { id: "enq-regras-rel", label: "Regras relacionais", icon: "shield-alert", section: "Enquadramento", path: "/enquadramento/regras-relacionais" },
  { id: "enq-grupos", label: "Grupos econômicos", icon: "users", section: "Enquadramento", path: "/enquadramento/grupos-economicos" },
  { id: "enq-relatorios", label: "Relatórios", icon: "clipboard-list", section: "Enquadramento", path: "/enquadramento/relatorios" },

  { id: "liq-visao-geral", label: "Visão geral", icon: "layout-dashboard", section: "Liquidez", path: "/liquidez/visao-geral" },
  { id: "liq-monitoramento", label: "Monitoramento", icon: "droplets", section: "Liquidez", path: "/liquidez/monitoramento-fundo" },
  { id: "liq-passivo", label: "Passivo fundos", icon: "file-text", section: "Liquidez", path: "/liquidez/passivo-fundos" },
  { id: "liq-matriz", label: "Matriz ANBIMA", icon: "table-2", section: "Liquidez", path: "/liquidez/matriz-anbima" },
  { id: "liq-resgates", label: "Resgates", icon: "receipt", section: "Liquidez", path: "/liquidez/resgates-solicitados" },
  { id: "liq-descasamento", label: "Descasamento", icon: "arrow-left-right", section: "Liquidez", path: "/liquidez/descasamento-operacional" },
  { id: "liq-relatorios", label: "Relatórios", icon: "clipboard-list", section: "Liquidez", path: "/liquidez/relatorios" },
  { id: "liq-mensal", label: "FIDC mensal", icon: "bar-chart-3", section: "Liquidez", path: "/liquidez/mensal" },
  { id: "liq-estoque-xml", label: "FIDC estoque + XML", icon: "table-2", section: "Liquidez", path: "/liquidez/estoque-xml" },

  { id: "cred-matriz", label: "Monitoramento", icon: "layout-grid", section: "Crédito", path: "/credito/matriz" },
  { id: "cred-rollrate", label: "Roll rate", icon: "trending-down", section: "Crédito", path: "/credito/rollrate" },
  { id: "cred-elegibilidade", label: "Elegibilidade", icon: "shield-check", section: "Crédito", path: "/credito/elegibilidade" },
  { id: "cred-partes", label: "Cadastro partes", icon: "users", section: "Crédito", path: "/credito/cadastro-partes" },
  { id: "cred-estoque", label: "Estoque FIDC", icon: "database", section: "Crédito", path: "/credito/estoque" },

  { id: "rentabilidade", label: "Rentabilidade fundos", icon: "line-chart", section: "Rentabilidade", path: "/rentabilidade" },
  { id: "rentabilidade-enviar", label: "Enviar relatório", icon: "mail", section: "Rentabilidade", path: "/rentabilidade/enviar-relatorio" },

  { id: "risco-mercado", label: "VaR por fundo", icon: "shield-alert", section: "Risco de mercado", path: "/risco-mercado" },

  { id: "cfg-gestores", label: "Gestores monitorados", icon: "settings", section: "Configurações", path: "/configuracoes/gestores" },
];

export const PORTAL_NAV_ITEMS = PORTAL_NAV.map(({ id, label, icon, section }) => ({
  id,
  label,
  icon,
  section,
}));

const PATH_ALIASES: Array<{ test: (path: string) => boolean; id: string; crumbs: { label: string }[]; title: string }> = [
  { test: (p) => p.startsWith("/dados/importar") || p.startsWith("/enquadramento/importar"), id: "importar", crumbs: [{ label: "Dados" }, { label: "Importações" }], title: "Importações" },
  { test: (p) => p.startsWith("/liquidez/consolidado"), id: "xml-dashboard", crumbs: [{ label: "Dados" }, { label: "XMLs" }], title: "Dashboard de XMLs" },
  { test: (p) => p.startsWith("/enquadramento/ativos"), id: "ativos", crumbs: [{ label: "Dados" }, { label: "Ativos" }], title: "Cardápio de ativos" },
  { test: (p) => p.startsWith("/enquadramento/carteira"), id: "enq-monitoramento", crumbs: [{ label: "Enquadramento" }, { label: "Monitoramento" }, { label: "Carteira" }], title: "Carteira" },
  { test: (p) => p.startsWith("/enquadramento/monitoramento"), id: "enq-monitoramento", crumbs: [{ label: "Enquadramento" }, { label: "Monitoramento" }], title: "Monitoramento de enquadramento" },
  { test: (p) => p.startsWith("/enquadramento/regras-relacionais"), id: "enq-regras-rel", crumbs: [{ label: "Enquadramento" }, { label: "Regras relacionais" }], title: "Regras relacionais" },
  { test: (p) => p.startsWith("/enquadramento/regras"), id: "enq-regras", crumbs: [{ label: "Enquadramento" }, { label: "Regras" }], title: "Regras" },
  { test: (p) => p.startsWith("/enquadramento/grupos-economicos"), id: "enq-grupos", crumbs: [{ label: "Enquadramento" }, { label: "Grupos" }], title: "Grupos econômicos" },
  { test: (p) => p.startsWith("/enquadramento/relatorios"), id: "enq-relatorios", crumbs: [{ label: "Enquadramento" }, { label: "Relatórios" }], title: "Relatórios de enquadramento" },
  { test: (p) => p.startsWith("/enquadramento"), id: "enq-dashboard", crumbs: [{ label: "Enquadramento" }, { label: "Dashboard" }], title: "Dashboard de enquadramento" },
  { test: (p) => p.startsWith("/liquidez/passivo-fundos"), id: "liq-passivo", crumbs: [{ label: "Liquidez" }, { label: "Passivo" }], title: "Passivo de fundos" },
  { test: (p) => p.startsWith("/liquidez/matriz-anbima"), id: "liq-matriz", crumbs: [{ label: "Liquidez" }, { label: "Matriz ANBIMA" }], title: "Matriz ANBIMA" },
  { test: (p) => p.startsWith("/liquidez/resgates-solicitados"), id: "liq-resgates", crumbs: [{ label: "Liquidez" }, { label: "Resgates" }], title: "Resgates solicitados" },
  { test: (p) => p.startsWith("/liquidez/descasamento-operacional"), id: "liq-descasamento", crumbs: [{ label: "Liquidez" }, { label: "Descasamento" }], title: "Descasamento operacional" },
  { test: (p) => p.startsWith("/liquidez/relatorios"), id: "liq-relatorios", crumbs: [{ label: "Liquidez" }, { label: "Relatórios" }], title: "Relatórios de liquidez" },
  { test: (p) => p.startsWith("/liquidez/mensal"), id: "liq-mensal", crumbs: [{ label: "Liquidez" }, { label: "FIDC mensal" }], title: "Liquidez mensal FIDC" },
  { test: (p) => p.startsWith("/liquidez/estoque-xml"), id: "liq-estoque-xml", crumbs: [{ label: "Liquidez" }, { label: "FIDC estoque + XML" }], title: "FIDC estoque + XML" },
  { test: (p) => p.startsWith("/liquidez/visao-geral"), id: "liq-visao-geral", crumbs: [{ label: "Liquidez" }, { label: "Visão geral" }], title: "Visão geral de liquidez" },
  { test: (p) => p.startsWith("/liquidez"), id: "liq-monitoramento", crumbs: [{ label: "Liquidez" }, { label: "Monitoramento" }], title: "Monitoramento de liquidez" },
  { test: (p) => p.startsWith("/credito/rollrate"), id: "cred-rollrate", crumbs: [{ label: "Crédito" }, { label: "Roll rate" }], title: "Roll rate / migração" },
  { test: (p) => p.startsWith("/credito/elegibilidade"), id: "cred-elegibilidade", crumbs: [{ label: "Crédito" }, { label: "Elegibilidade" }], title: "Elegibilidade" },
  { test: (p) => p.startsWith("/credito/cadastro-partes"), id: "cred-partes", crumbs: [{ label: "Crédito" }, { label: "Partes" }], title: "Cadastro de partes" },
  { test: (p) => p.startsWith("/credito/estoque"), id: "cred-estoque", crumbs: [{ label: "Crédito" }, { label: "Estoque" }], title: "Estoque FIDC" },
  { test: (p) => p.startsWith("/credito"), id: "cred-matriz", crumbs: [{ label: "Crédito" }, { label: "Monitoramento" }], title: "Monitoramento de crédito" },
  { test: (p) => p.startsWith("/rentabilidade/enviar-relatorio") || p.startsWith("/controle-cotas/enviar-relatorio"), id: "rentabilidade-enviar", crumbs: [{ label: "Rentabilidade" }, { label: "Envio" }], title: "Enviar relatório de rentabilidade" },
  { test: (p) => p.startsWith("/rentabilidade") || p.startsWith("/controle-cotas/rentabilidade"), id: "rentabilidade", crumbs: [{ label: "Rentabilidade" }, { label: "Fundos" }], title: "Rentabilidade de fundos" },
  { test: (p) => p.startsWith("/risco-mercado"), id: "risco-mercado", crumbs: [{ label: "Risco de mercado" }, { label: "Fundos" }], title: "VaR por fundo" },
  { test: (p) => p.startsWith("/configuracoes/gestores") || p.startsWith("/dados/gestores-monitorados"), id: "cfg-gestores", crumbs: [{ label: "Configurações" }, { label: "Gestores" }], title: "Gestores monitorados" },
];

export function resolveShellMeta(pathname: string) {
  const hit = PATH_ALIASES.find((item) => item.test(pathname));
  if (hit) return { activeId: hit.id, breadcrumbs: hit.crumbs, title: hit.title };
  return {
    activeId: "liq-monitoramento",
    breadcrumbs: [{ label: "Risco CVPAR" }],
    title: "Portal de risco",
  };
}

export const ROUTE_MAP: Record<string, string> = Object.fromEntries(
  PORTAL_NAV.map((item) => [item.id, item.path])
);
