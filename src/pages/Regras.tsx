import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ORIGEM_PL_CONCENTRACAO_DEFAULT } from "@/lib/fidcConcentracaoPlOrigem";
import { Layout } from "@/components/Layout";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Search, Plus, Pencil, Trash2, Loader2, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  TRIB_CODIGOS,
  type VarianteArt4,
  buildDescricaoTributario,
  buildParametrosTributarioArt4,
  buildParametrosTributarioArt5,
  codigoFromTributario,
  hydrateTributarioFromParametros,
  isTipoRegraTributaria,
  tipoFromCodigoTributario,
  TRIB_TIPOS_EXCLUIDOS_PADRAO,
} from "@/lib/regrasTributariasCatalog";
import {
  buildCodigoSubordinacao,
  buildDescricaoSubordinacao,
  buildParametrosSubordinacao,
  normalizeSeries,
  ORIGEM_PL_ESTRUTURA_DEFAULT,
  parseParametrosFidcSubordinacao,
  type ClasseAlvoSubordinacao,
  type ComposicaoNumeradorSubordinacao,
} from "@/lib/fidcEstruturaCatalog";
import { buildFundosSubclasseList, normalizeCnpj14 } from "@/lib/fundoRegrasUtils";
import { CADASTRO_PARTES_DEFAULTS, type PoliticaCadastro } from "@/lib/cadastroPartes";

type TipoRegra =
  | "percentual_pl_por_categoria"
  | "limite_por_tipo_investidor"
  | "vedacao"
  | "agrupamento_conjunto"
  | "CONCENTRACAO_DEVEDOR"
  | "CONCENTRACAO_CEDENTE"
  | "CONCENTRACAO_SEM_COOBRIGACAO"
  | "CESSAO_CONDICAO"
  | "CESSAO_CADASTRO_PARTES"
  | "tributario_prazo_medio_art4"
  | "tributario_fiq_art5"
  /** Regra de classe mínima: FIDC ≥ X%, FII ≥ X%, FIP ≥ X%. Parametriza CLASSE_FIDC_67 / CLASSE_FII_67 / CLASSE_FIP_90. */
  | "classe_min"
  /** Subordinação multiclasse FIDC — (JR[+MEZ]) / PL Classe */
  | "fidc_subordinacao";

type ComponenteConjunto = {
  id: string;
  tipo: "tipo_investidor" | "cotas" | "ativos_financeiros";
  valor: string;
  peso: number;
};

type ModoAgrupamento = "por_regras" | "por_componentes";

const CESSAO_CAMPOS = [
  { value: "vencimento", label: "DC Vencido (vencimento < data cessão)" },
  { value: "prazo", label: "Prazo do Recebível (dias)" },
  { value: "taxa_cessao_implicita", label: "Taxa Implícita de Cessão por Cedente (juros compostos, % CDI)" },
  { value: "taxa_cessao", label: "Taxa de Cessão declaratória (simplificado, % CDI)" },
  { value: "inadimplencia_cedente", label: "Inadimplência do Cedente (dias atraso)" },
  { value: "prazo_medio", label: "Prazo Médio da Carteira pró-forma (dias)" },
  { value: "exposicao_prazo_acima", label: "Exposição com prazo > N dias (% PL)" },
  { value: "tipo_recebivel", label: "Tipo de Recebível permitido" },
  { value: "substituicao_unica", label: "Substituição/recompra única por título (6.2(f))" },
  { value: "concentracao_devedor", label: "Concentração por Devedor/Sacado (% PL)" },
  { value: "concentracao_cedente", label: "Concentração por Cedente (% PL)" },
  { value: "sem_coobrigacao", label: "Total Sem Coobrigação (% PL)" },
] as const;

const CESSAO_MODOS = [
  { value: "individual", label: "Individual (por DC)" },
  { value: "proforma", label: "Pró-forma (carteira simulada)" },
  { value: "concentracao", label: "Concentração (estoque + cessão)" },
] as const;

const CESSAO_OPERADORES = [
  { value: "<=", label: "≤ (menor ou igual)" },
  { value: ">=", label: "≥ (maior ou igual)" },
  { value: "<", label: "< (menor que)" },
  { value: ">", label: "> (maior que)" },
  { value: "==", label: "= (igual)" },
  { value: "!=", label: "≠ (diferente)" },
] as const;

const CESSAO_UNIDADES = [
  { value: "dias", label: "Dias" },
  { value: "percentual_pl", label: "% do PL" },
  { value: "percentual_cdi", label: "% do CDI" },
  { value: "reais", label: "R$" },
] as const;

const TIPOS_RECEBIVEL = [
  "Duplicata", "Duplicata de Servico Fisico", "Duplicata Mercantil",
  "CCB", "Nota Comercial", "Contrato", "Cheque", "Outros",
];

type RegraCompliance = {
  id: string;
  codigo: string;
  descricao: string;
  parametros: Record<string, unknown>;
  created_at: string;
};

type ModoExcecaoSacado = "ignorar" | "limite_customizado";

type ExcecaoSacadoForm = {
  chave: string;
  nome: string;
  documento: string | null;
  modo: ModoExcecaoSacado;
  limiteMaxPct: number | "";
};

type SacadoDisponivel = {
  chave: string;
  nome: string;
  documento: string | null;
  exposicao: number;
};

// Tipos de COTAS (fundos investidos - section cotas) - ANBIMA nivel1 + FICs
const COTAS_TIPOS_BASE: string[] = [
  "Todas", // Todas as cotas (section cotas)
  "Ações",
  "Cambial",
  "ETF",
  "FIAGRO",
  "FIA",
  "FIC",
  "FIC FIDC",
  "FIC FII",
  "FIC FIM",
  "FIC FIP",
  "FIDC",
  "FIDC NP",
  "FII",
  "FIP",
  "Multimercados",
  "Previdência",
  "Renda Fixa",
  "Investimento no Exterior",
].sort();

// Sections da carteira para ATIVOS FINANCEIROS (ativos diretos, não cotas)
const ATIVOS_FINANCEIROS_SECTIONS: { value: string; label: string }[] = [
  { value: "titpublico", label: "Título Público" },
  { value: "titprivado", label: "Título Privado" },
  { value: "participacoes", label: "Participações" },
  { value: "acoes", label: "Ações" },
  { value: "imoveis", label: "Imóveis" },
  { value: "fidc", label: "FIDC (ativos)" },
  { value: "caixa", label: "Caixa" },
  { value: "outros", label: "Outros" },
];

// Códigos ANBIMA de provisão para filtro granular em "Outros"
const PROVISAO_CODPROV_CONHECIDOS: { value: string; label: string }[] = [
  { value: "999", label: "999 — Direito Creditório NC (op. não liquidada)" },
  { value: "8",   label: "8 — Movimentação de Cotas" },
  { value: "1",   label: "1 — Resgate de Cotas" },
  { value: "2",   label: "2 — Aplicação de Cotas" },
  { value: "9",   label: "9 — Rendimentos a Pagar" },
];

// Valores armazenados em fundos_caracteristicas.caracteristica_investidor (ANBIMA)
const TIPOS_INVESTIDOR = [
  { value: "Geral", label: "Público em Geral" },
  { value: "Qualificado", label: "Investidor Qualificado" },
  { value: "Institucional", label: "Investidor Qualificado (Institucional)" },
  { value: "Profissional", label: "Investidor Profissional" },
] as const;

function buildParametros(
  tipo: TipoRegra,
  nivel1_categoria?: string,
  tipo_investidor?: string,
  limiteMinPct?: number,
  limiteMaxPct?: number,
  tipoFundo?: string,
  categoriaVedada?: string,
  nivel1CategoriaInvestidor?: string,
  segmento?: "COTAS" | "ATIVOS_FINANCEIROS",
  sectionCarteira?: string,
  segmentos?: string[],
  nivel1_categorias?: string[],
  section_carteiras?: string[],
  categoriasVedadas?: string[],
  fundosCnpj?: string[],
  mesmaAdministradora?: boolean,
  baseCalculo?: string,
  fundoExcecaoCnpj?: string,
  excecoesSacado?: ExcecaoSacadoForm[],
  usarAbatimentoPdd?: boolean,
  origemPl?: string,
  componentes?: ComponenteConjunto[],
  metodoAgregacao?: string,
  modoAgrupamento?: ModoAgrupamento,
  regrasBase?: string[],
  outrosProvisaoCodprov?: string[],
  classeSecoesAdicionais?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (limiteMinPct != null && limiteMinPct > 0) out.limite_min = limiteMinPct / 100;
  if (limiteMaxPct != null && limiteMaxPct > 0) {
    out.limite_max = limiteMaxPct / 100;
    out.limite = out.limite_max; // retrocompat
  }

  // Regra de Classe Mínima (FIDC/FII/FIP)
  if (tipo === "classe_min") {
    const p: Record<string, unknown> = {
      tipo_regra: "classe_min",
      tipo_fundo: tipoFundo || "FIDC",
      limite: (limiteMinPct ?? 67) / 100,
      limite_alerta: (limiteMaxPct ?? 70) / 100,
    };
    if (classeSecoesAdicionais && classeSecoesAdicionais.length > 0) {
      p.secoes_contribuicao = classeSecoesAdicionais;
    }
    return p;
  }

  // Regra de agrupamento conjunto
  if (tipo === "agrupamento_conjunto") {
    const params: Record<string, unknown> = {
      tipo_regra: "agrupamento_conjunto",
      limite_max: (limiteMaxPct ?? 0) / 100,
      metodo_agregacao: metodoAgregacao || "soma",
      deduplicar_por: "id_ativo",
      modo: modoAgrupamento || "por_componentes"
    };

    if (modoAgrupamento === "por_regras" && regrasBase && regrasBase.length > 0) {
      params.regras_base = regrasBase;
    } else {
      params.componentes = (componentes || []).map(c => ({
        tipo: c.tipo,
        valor: c.valor,
        peso: c.peso || 1.0
      }));
    }

    return params;
  }

  // Regras de concentração FIDC — usam estoque granular de direitos creditórios
  if (
    tipo === "CONCENTRACAO_DEVEDOR" ||
    tipo === "CONCENTRACAO_CEDENTE" ||
    tipo === "CONCENTRACAO_SEM_COOBRIGACAO"
  ) {
    const params: Record<string, unknown> = {
      tipo_regra: tipo,
      limite_min: limiteMinPct != null ? limiteMinPct / 100 : 0,
      ...(limiteMaxPct != null ? { limite_max: limiteMaxPct / 100 } : {}),
      base_calculo: baseCalculo || "valor_presente",
      usar_abatimento_pdd: usarAbatimentoPdd ?? true,
      origem_pl: origemPl || ORIGEM_PL_CONCENTRACAO_DEFAULT,
    };

    if (
      tipo === "CONCENTRACAO_DEVEDOR" &&
      fundoExcecaoCnpj &&
      excecoesSacado &&
      excecoesSacado.length > 0
    ) {
      params.fundo_excecao_cnpj = fundoExcecaoCnpj;
      params.excecoes_sacado_por_fundo = {
        [fundoExcecaoCnpj]: excecoesSacado.map((item) => ({
          chave: item.chave,
          nome: item.nome,
          documento: item.documento,
          modo: item.modo,
          ...(item.modo === "limite_customizado" && item.limiteMaxPct !== ""
            ? { limite_max: Number(item.limiteMaxPct) / 100 }
            : {}),
        })),
      };
    }

    return params;
  }
  if (tipo === "percentual_pl_por_categoria") {
    const params: Record<string, unknown> = {
      tipo_regra: "percentual_pl_por_categoria",
      ...out,
    };
    if (segmentos && segmentos.length > 0) {
      params.segmentos = segmentos.map((s) => s === "COTAS" ? "cotas" : "ativos_financeiros");
      if (segmentos.includes("COTAS") && nivel1_categorias && nivel1_categorias.length > 0) {
        const cats = nivel1_categorias.filter((c) => c !== "Todas");
        if (cats.length > 0) params.nivel1_categorias = cats;
      }
      if (segmentos.includes("ATIVOS_FINANCEIROS") && section_carteiras && section_carteiras.length > 0) {
        params.section_carteiras = section_carteiras;
        if (section_carteiras.includes("outros") && outrosProvisaoCodprov && outrosProvisaoCodprov.length > 0) {
          params.outros_provisao_codprov = outrosProvisaoCodprov;
        }
      }
    } else if (segmento === "ATIVOS_FINANCEIROS" && sectionCarteira) {
      params.segmento = "ativos_financeiros";
      params.section_carteira = sectionCarteira;
    } else {
      params.segmento = "cotas";
      params.nivel1_categoria = nivel1_categoria || "FIDC";
    }
    return params;
  }
  if (tipo === "vedacao") {
    const p: Record<string, unknown> = { tipo_regra: "vedacao" };
    if (tipoFundo) p.tipo_fundo = tipoFundo;
    const cats = categoriasVedadas as string[] | undefined;
    if (cats && cats.length > 0) {
      p.categorias_vedadas = cats;
    } else if (categoriaVedada) {
      p.categoria_vedada = categoriaVedada; // retrocompat single
    }
    const fundos = fundosCnpj as string[] | undefined;
    if (fundos && fundos.length > 0) p.fundos_cnpj = fundos;
    return p;
  }
  const params: Record<string, unknown> = {
    tipo_regra: "limite_por_tipo_investidor",
    limite: (limiteMaxPct ?? limiteMinPct ?? 10) / 100,
    tipo_investidor: tipo_investidor || "Profissional",
    ...out,
  };
  if (nivel1CategoriaInvestidor) params.nivel1_categoria = nivel1CategoriaInvestidor;
  if (mesmaAdministradora) params.mesma_administradora = true;
  return params;
}

function buildCodigoClasseMin(tipoFundo: string, limiteMin: number | ""): string {
  const pct = typeof limiteMin === "number" ? limiteMin : 67;
  const tf = tipoFundo.replace(/\s/g, "_").toUpperCase();
  return `CLASSE_${tf}_${pct}`;
}

function buildCodigo(
  tipo: TipoRegra,
  nivel1_categoria?: string,
  limiteMinPct?: number,
  limiteMaxPct?: number,
  tipoFundo?: string,
  categoriaVedada?: string,
  tipoInvestidor?: string,
  nivel1CategoriaInvestidor?: string,
  segmento?: "COTAS" | "ATIVOS_FINANCEIROS",
  sectionCarteira?: string,
  segmentos?: string[],
  cotasTipos?: string[],
  sectionCarteiras?: string[],
  categoriasVedadas?: string[],
  fundosCnpj?: string[],
  mesmaAdministradora?: boolean,
  componentes?: ComponenteConjunto[],
  regrasBase?: string[]
): string {
  const pct = limiteMaxPct ?? limiteMinPct ?? 0;
  if (tipo === "CESSAO_CONDICAO") return "";
  if (isTipoRegraTributaria(tipo)) return "";
  if (tipo === "classe_min") return buildCodigoClasseMin(tipoFundo || "FIDC", limiteMinPct ?? "");
  if (tipo === "agrupamento_conjunto") {
    const count = regrasBase && regrasBase.length > 0 ? regrasBase.length : componentes?.length || 0;
    const suffix = count > 0 ? `_${count}REGRAS` : "";
    return `GRUPO_CONJUNTO${suffix}_MAX${pct}`;
  }
  if (tipo === "CONCENTRACAO_DEVEDOR") return `CONC_DEVEDOR_${pct}`;
  if (tipo === "CONCENTRACAO_CEDENTE") return `CONC_CEDENTE_${pct}`;
  if (tipo === "CONCENTRACAO_SEM_COOBRIGACAO") return `CONC_SEM_COOBR_${pct}`;
  const hasMin = limiteMinPct != null && limiteMinPct > 0;
  const hasMax = limiteMaxPct != null && limiteMaxPct > 0;
  let cat = "";
  if (segmentos && segmentos.length > 0) {
    const parts: string[] = [];
    if (segmentos.includes("COTAS") && cotasTipos && cotasTipos.length > 0) {
      const c = cotasTipos.filter((t) => t !== "Todas");
      parts.push(c.length > 0 ? c.join("_") : "Cotas");
    }
    if (segmentos.includes("ATIVOS_FINANCEIROS") && sectionCarteiras && sectionCarteiras.length > 0) {
      parts.push(...sectionCarteiras.map((s) => s.toUpperCase().replace(/-/g, "_")));
    }
    cat = parts.join("_");
  } else if (segmento === "ATIVOS_FINANCEIROS" && sectionCarteira) {
    cat = sectionCarteira.toUpperCase().replace(/-/g, "_");
  } else {
    cat = nivel1_categoria?.replace(/\s/g, "_") ?? "";
  }
  if (tipo === "percentual_pl_por_categoria" && cat && (hasMin || hasMax)) {
    if (hasMin && hasMax) return `LIMITE_${cat}_MIN${limiteMinPct}_MAX${limiteMaxPct}`;
    if (hasMin) return `LIMITE_MIN_${cat}_${limiteMinPct}`;
    return `LIMITE_MAX_${cat}_${limiteMaxPct}`;
  }
  if (tipo === "limite_por_tipo_investidor" && (hasMin || hasMax)) {
    const pct = limiteMaxPct ?? limiteMinPct ?? 10;
    const inv = (tipoInvestidor || "Profissional").replace(/\s/g, "_");
    const cat = nivel1CategoriaInvestidor ? `_${nivel1CategoriaInvestidor.replace(/\s/g, "_")}` : "";
    const adm = mesmaAdministradora ? "_MESMA_ADM" : "";
    return `LIMITE_MAX_${inv}${cat}${adm}_${pct}`;
  }
  if (tipo === "vedacao") {
    const cats = categoriasVedadas;
    const catStr = cats?.length ? cats.join("_") : (categoriaVedada || "");
    const scope = tipoFundo ? tipoFundo : (fundosCnpj?.length ? "FUNDOS" : "");
    if (catStr && scope) return `VEDACAO_${scope}_${catStr}`;
    if (catStr) return `VEDACAO_${catStr}`;
  }
  return "";
}

function buildDescricao(
  tipo: TipoRegra,
  nivel1_categoria?: string,
  tipo_investidor?: string,
  limiteMinPct?: number,
  limiteMaxPct?: number,
  tipoFundo?: string,
  categoriaVedada?: string,
  nivel1CategoriaInvestidor?: string,
  segmento?: "COTAS" | "ATIVOS_FINANCEIROS",
  sectionCarteira?: string,
  segmentos?: string[],
  cotasTipos?: string[],
  sectionCarteiras?: string[],
  categoriasVedadas?: string[],
  fundosCnpj?: string[],
  mesmaAdministradora?: boolean,
  componentes?: ComponenteConjunto[],
  regrasBase?: string[]
): string {
  const hasMin = limiteMinPct != null && limiteMinPct > 0;
  const hasMax = limiteMaxPct != null && limiteMaxPct > 0;
  const pct = limiteMaxPct ?? limiteMinPct ?? 0;
  if (tipo === "CESSAO_CONDICAO") return "";
  if (isTipoRegraTributaria(tipo)) return "";
  if (tipo === "agrupamento_conjunto") {
    const count = regrasBase && regrasBase.length > 0 ? regrasBase.length : componentes?.length || 0;
    const tipoLbl = regrasBase && regrasBase.length > 0 ? "regras" : "componentes";
    return `Limite conjunto (${count} ${tipoLbl}) — máximo ${pct}% do PL`;
  }
  if (tipo === "CONCENTRACAO_DEVEDOR") {
    return `Direitos Creditórios de um mesmo Devedor — máximo ${pct}% do PL da Classe`;
  }
  if (tipo === "CONCENTRACAO_CEDENTE") {
    return `Direitos Creditórios de um mesmo Cedente e/ou Emissor — máximo ${pct}% do PL da Classe`;
  }
  if (tipo === "CONCENTRACAO_SEM_COOBRIGACAO") {
    return `Soma dos Direitos Creditórios sem coobrigação dos Cedentes — máximo ${pct}% do PL da Classe`;
  }
  if (tipo === "classe_min") {
    const tf = tipoFundo || "FIDC";
    const limPct = limiteMinPct ?? 67;
    const alertPct = limiteMaxPct ?? 70;
    return `Mínimo de ${limPct}% do investimento em ${tf}s (para fundos ${tf}) — alerta em ${alertPct}%`;
  }
  if (tipo === "fidc_subordinacao") {
    return buildDescricaoSubordinacao(
      (tipoFundo as ClasseAlvoSubordinacao) || "senior",
      limiteMinPct ?? 10,
      limiteMaxPct ?? 12,
      (segmento as ComposicaoNumeradorSubordinacao) || "jr_mez",
    );
  }
  if (tipo === "percentual_pl_por_categoria") {
    let label: string;
    if (segmentos && segmentos.length > 0) {
      const parts: string[] = [];
      if (segmentos.includes("COTAS") && cotasTipos && cotasTipos.length > 0) {
        const c = cotasTipos.filter((t) => t !== "Todas");
        parts.push(c.length > 0 ? `em cotas de ${c.join(", ")}` : "em cotas");
      }
      if (segmentos.includes("ATIVOS_FINANCEIROS") && sectionCarteiras && sectionCarteiras.length > 0) {
        const secLabels = sectionCarteiras.map((v) => ATIVOS_FINANCEIROS_SECTIONS.find((s) => s.value === v)?.label ?? v);
        parts.push(`em ${secLabels.join(", ")}`);
      }
      label = parts.join(" e ");
    } else if (segmento === "ATIVOS_FINANCEIROS" && sectionCarteira) {
      const opt = ATIVOS_FINANCEIROS_SECTIONS.find((s) => s.value === sectionCarteira);
      label = `em ${opt?.label ?? sectionCarteira}`;
    } else if (nivel1_categoria === "Todas" || nivel1_categoria === "Cotas") {
      label = "em cotas";
    } else {
      label = `em cotas de ${nivel1_categoria}`;
    }
    const parts: string[] = [];
    if (hasMax) parts.push(`no máximo ${limiteMaxPct}%`);
    if (hasMin) parts.push(`no mínimo ${limiteMinPct}%`);
    if (parts.length === 0) return `Fundo ${label}`;
    return `Fundo pode ter ${parts.join(" e ")} do PL ${label}`;
  }
  if (tipo === "vedacao") {
    const cats = categoriasVedadas?.length ? categoriasVedadas : (categoriaVedada ? [categoriaVedada] : []);
    const catLabel = cats.length ? cats.join(", ") : "";
    const scopeLabel = tipoFundo ? `${tipoFundo} ` : (fundosCnpj?.length ? "Fundos selecionados " : "");
    if (catLabel && (tipoFundo || fundosCnpj?.length)) return `${scopeLabel}não pode(m) ter cotas de ${catLabel}`;
    if (catLabel) return `Não pode ter cotas de ${catLabel}`;
  }
  const inv = tipo_investidor || "Profissional";
  const invLabel = TIPOS_INVESTIDOR.find(t => t.value === inv)?.label ?? inv;
  const pctInvestidor = limiteMaxPct ?? limiteMinPct ?? 10;
  const catLabel = nivel1CategoriaInvestidor ? ` em cotas de ${nivel1CategoriaInvestidor}` : "";
  const admLabel = mesmaAdministradora ? ", administrados pela mesma administradora" : "";
  return `Fundo pode ter no máximo ${pctInvestidor}% do PL em fundos do tipo ${invLabel}${catLabel}${admLabel}`;
}

export default function Regras() {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [formTipo, setFormTipo] = useState<TipoRegra>("percentual_pl_por_categoria");
  const [formSegmentos, setFormSegmentos] = useState<string[]>(["COTAS"]);
  const [formCotasTipos, setFormCotasTipos] = useState<string[]>(["Todas"]);
  const [formSectionCarteiras, setFormSectionCarteiras] = useState<string[]>(["titpublico"]);
  // Quando "outros" está selecionado em section_carteiras, permite filtrar por codprov de provisão
  const [formOutrosProvisaoCodprov, setFormOutrosProvisaoCodprov] = useState<string[]>([]);
  const [formOutrosProvisaoCustomCod, setFormOutrosProvisaoCustomCod] = useState<string>("");

  // Regra de Classe Mínima (classe_min) — FIDC ≥ X%, FII ≥ X%, FIP ≥ X%
  const [formClasseTipoFundo, setFormClasseTipoFundo] = useState<string>("FIDC");
  const [formClasseLimiteMin, setFormClasseLimiteMin] = useState<number | "">(67);
  const [formClasseLimiteAlerta, setFormClasseLimiteAlerta] = useState<number | "">(70);
  // Seções adicionais que compõem o numerador além do padrão (fidc + cotas FIDC + prov 999/C)
  const [formClasseSecoesAdicionais, setFormClasseSecoesAdicionais] = useState<string[]>([]);
  // Subordinação FIDC multiclasse (fidc_subordinacao)
  const [formFidcClasseAlvo, setFormFidcClasseAlvo] = useState<ClasseAlvoSubordinacao>("senior");
  const [formFidcLimiteMin, setFormFidcLimiteMin] = useState<number | "">(10);
  const [formFidcLimiteAlerta, setFormFidcLimiteAlerta] = useState<number | "">(12);
  const [formFidcNumerador, setFormFidcNumerador] = useState<ComposicaoNumeradorSubordinacao>("jr_mez");
  const [formFidcOrigemPl, setFormFidcOrigemPl] = useState<string>(ORIGEM_PL_ESTRUTURA_DEFAULT);
  const [formFidcObservacao, setFormFidcObservacao] = useState("");
  const [formFidcSeriesCnpj, setFormFidcSeriesCnpj] = useState("");
  const [formFidcSeriesJr, setFormFidcSeriesJr] = useState<string[]>([]);
  const [formFidcSeriesMez, setFormFidcSeriesMez] = useState<string[]>([]);
  const [formFidcSeriesSenior, setFormFidcSeriesSenior] = useState<string[]>([]);
  const [formNivel1, setFormNivel1] = useState<string>(""); // retrocompat / limite_por_tipo_investidor
  const [formTipoInvestidor, setFormTipoInvestidor] = useState("Profissional");
  const [formLimiteMinPct, setFormLimiteMinPct] = useState<number | "">("");
  const [formLimiteMaxPct, setFormLimiteMaxPct] = useState<number | "">(40);
  const [formTipoFundo, setFormTipoFundo] = useState<string>("");
  const [formCategoriasVedadas, setFormCategoriasVedadas] = useState<string[]>([]);
  const [formFundosCnpj, setFormFundosCnpj] = useState<string[]>([]);
  const [buscaFundos, setBuscaFundos] = useState("");
  const [formNivel1Investidor, setFormNivel1Investidor] = useState<string>("");
  const [formMesmaAdministradora, setFormMesmaAdministradora] = useState(false);
  const [formCodigoEditavel, setFormCodigoEditavel] = useState<string>("");
  const [formBaseCalculo, setFormBaseCalculo] = useState<string>("valor_presente");
  const [formUsarAbatimentoPdd, setFormUsarAbatimentoPdd] = useState<boolean>(true);
  const [formOrigemPl, setFormOrigemPl] = useState<string>(ORIGEM_PL_CONCENTRACAO_DEFAULT);
  const [formExcecaoFundoCnpj, setFormExcecaoFundoCnpj] = useState<string>("");
  const [formExcecoesSacado, setFormExcecoesSacado] = useState<ExcecaoSacadoForm[]>([]);
  const [buscaSacados, setBuscaSacados] = useState("");

  // CESSAO_CONDICAO form fields
  const [formCessaoCampo, setFormCessaoCampo] = useState<string>("vencimento");
  const [formCessaoModo, setFormCessaoModo] = useState<string>("individual");
  const [formCessaoOperador, setFormCessaoOperador] = useState<string>("<=");
  const [formCessaoValorLimite, setFormCessaoValorLimite] = useState<number | "">(365);
  const [formCessaoUnidade, setFormCessaoUnidade] = useState<string>("dias");
  const [formCessaoCdiVigente, setFormCessaoCdiVigente] = useState<number | "">(14.65);
  const [formCessaoFiltroTipoRecebivel, setFormCessaoFiltroTipoRecebivel] = useState<string[]>([]);
  const [formCessaoDiasReferencia, setFormCessaoDiasReferencia] = useState<number | "">(90);
  const [formCessaoDescricaoLivre, setFormCessaoDescricaoLivre] = useState<string>("");
  const [formCessaoRefRegulamento, setFormCessaoRefRegulamento] = useState<string>("");

  // CESSAO_CADASTRO_PARTES — regra ativadora (lista em /credito/cadastro-partes)
  const [formCadVerificarCedente, setFormCadVerificarCedente] = useState(true);
  const [formCadVerificarSacado, setFormCadVerificarSacado] = useState(false);
  const [formCadPoliticaNaoCadastrado, setFormCadPoliticaNaoCadastrado] = useState<PoliticaCadastro>("vedar");
  const [formCadPoliticaVencido, setFormCadPoliticaVencido] = useState<PoliticaCadastro>("vedar");
  const [formCadPoliticaPendente, setFormCadPoliticaPendente] = useState<PoliticaCadastro>("alertar");
  const [formCadValidadeInclusiva, setFormCadValidadeInclusiva] = useState(true);

  // Agrupamento Conjunto form fields
  const [formComponentes, setFormComponentes] = useState<ComponenteConjunto[]>([]);
  const [formMetodoAgregacao, setFormMetodoAgregacao] = useState<string>("soma");
  const [formModoAgrupamento, setFormModoAgrupamento] = useState<ModoAgrupamento>("por_regras");
  const [formRegrasBaseSelecionadas, setFormRegrasBaseSelecionadas] = useState<string[]>([]);
  const [buscaRegras, setBuscaRegras] = useState("");

  const [formTribVarianteArt4, setFormTribVarianteArt4] = useState<VarianteArt4>("fim");
  const [formTribLimiteDias, setFormTribLimiteDias] = useState<number>(365);
  const [formTribAlertaDias, setFormTribAlertaDias] = useState<number>(367);
  const [formTribLimiteMm, setFormTribLimiteMm] = useState<number>(90);
  const [formTribAlertaMm, setFormTribAlertaMm] = useState<number>(92);
  const [formTribDenominadorElegivel, setFormTribDenominadorElegivel] = useState(false);
  const [formTribTiposExcluidos, setFormTribTiposExcluidos] = useState<string[]>([...TRIB_TIPOS_EXCLUIDOS_PADRAO]);

  const { data: categoriasFundo = [], isLoading: isLoadingCategorias } = useQuery({
    queryKey: ["categorias-fundo"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("nivel1_categoria")
        .not("nivel1_categoria", "is", null)
        .limit(5000);
      if (error) throw error;
      const fromDb = [...new Set((data as any[]).map((d) => d.nivel1_categoria).filter(Boolean))] as string[];
      const merged = [...new Set([...COTAS_TIPOS_BASE, ...fromDb])].filter((c) => c !== "Todas").sort();
      return merged;
    },
  });

  const cotasTipos = ["Todas", ...categoriasFundo];

  const tiposExcluidosArt5Opcoes = useMemo(() => {
    const merged = new Set<string>([
      ...TRIB_TIPOS_EXCLUIDOS_PADRAO,
      ...categoriasFundo.filter((c) => c !== "Todas" && c !== "Cotas"),
    ]);
    return [...merged].sort((a, b) => a.localeCompare(b));
  }, [categoriasFundo]);

  const { data: fundosLista = [], isLoading: isLoadingFundos } = useQuery({
    queryKey: ["fundos-posicao-regras"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, fundo_nome, nome_fundo")
        .order("fundo_dtposicao", { ascending: false })
        .limit(10000);
      if (error) throw error;
      const rows = data || [];
      const unique = new Map<string, { cnpj: string; nome: string }>();
      const cnpjNorm = (c: string) => String(c || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
      rows.forEach((r: any) => {
        if (!r.fundo_cnpj) return;
        const key = cnpjNorm(r.fundo_cnpj);
        const nome = (r.fundo_nome || r.nome_fundo || r.fundo_cnpj).trim();
        if (!unique.has(key)) unique.set(key, { cnpj: key, nome });
      });
      const list = Array.from(unique.values());
      if (list.length > 0) {
        const cnpjs = list.slice(0, 1000).map((f) => f.cnpj);
        const { data: charData } = await supabase
          .from("fundos_caracteristicas" as any)
          .select("cnpj_classe, cnpj_fundo, nome_comercial")
          .in("cnpj_classe", cnpjs);
        (charData || []).forEach((row: any) => {
          const cnpj = row.cnpj_classe || row.cnpj_fundo;
          if (!cnpj) return;
          const key = cnpjNorm(cnpj);
          const nome = (row.nome_comercial || "").trim();
          if (nome && unique.has(key)) unique.set(key, { ...unique.get(key)!, nome });
        });
      }
      return list.sort((a, b) => a.nome.localeCompare(b.nome));
    },
    enabled: dialogOpen && (formTipo === "vedacao" || formTipo === "CONCENTRACAO_DEVEDOR"),
  });

  const cnpjFidcSeriesNorm = normalizeCnpj14(formFidcSeriesCnpj || "");
  const { data: fidcSubclasses = [] } = useQuery({
    queryKey: ["fidc-subclasses-regras", cnpjFidcSeriesNorm],
    enabled: dialogOpen && formTipo === "fidc_subordinacao" && cnpjFidcSeriesNorm.length === 14,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_cnpj, fundo_isin, fundo_nome, nome_fundo")
        .eq("fundo_cnpj", cnpjFidcSeriesNorm)
        .order("fundo_dtposicao", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return buildFundosSubclasseList(data || []);
    },
  });

  const toggleFidcSeriesIsin = (isin: string, papel: "jr" | "mez" | "senior") => {
    const remove = (list: string[]) => list.filter((i) => i !== isin);
    setFormFidcSeriesJr((prev) => (papel === "jr" ? [...remove(prev), isin] : remove(prev)));
    setFormFidcSeriesMez((prev) => (papel === "mez" ? [...remove(prev), isin] : remove(prev)));
    setFormFidcSeriesSenior((prev) => (papel === "senior" ? [...remove(prev), isin] : remove(prev)));
  };

  const fidcSeriesPapel = (isin: string): "jr" | "mez" | "senior" | null => {
    if (formFidcSeriesJr.includes(isin)) return "jr";
    if (formFidcSeriesMez.includes(isin)) return "mez";
    if (formFidcSeriesSenior.includes(isin)) return "senior";
    return null;
  };

  const { data: sacadosDisponiveis = [], isLoading: isLoadingSacados } = useQuery({
    queryKey: ["sacados-estoque-fidc", formExcecaoFundoCnpj],
    enabled: dialogOpen && formTipo === "CONCENTRACAO_DEVEDOR" && !!formExcecaoFundoCnpj,
    queryFn: async () => {
      const cnpjNorm = (c: string) => String(c || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
      const chaveSacado = (doc: string | null, nome: string | null) =>
        cnpjNorm(doc || "") || (nome || "").trim().toUpperCase();

      const { data: imports, error: importError } = await supabase
        .from("importacoes_estoque_fidc" as any)
        .select("id, fund_document, reference_date, status")
        .in("status", ["success", "partial_success"])
        .order("reference_date", { ascending: false })
        .limit(100);
      if (importError) throw importError;

      const latestImport = (imports || []).find((row: any) => cnpjNorm(row.fund_document) === cnpjNorm(formExcecaoFundoCnpj));
      if (!latestImport) return [];

      const { data: estoque, error: estoqueError } = await supabase
        .from("estoque_fidc" as any)
        .select("doc_sacado, nome_sacado, valor_presente")
        .eq("import_id", latestImport.id)
        .limit(50000);
      if (estoqueError) throw estoqueError;

      const grouped = new Map<string, SacadoDisponivel>();
      (estoque || []).forEach((row: any) => {
        const chave = chaveSacado(row.doc_sacado, row.nome_sacado);
        if (!chave) return;
        const nome = (row.nome_sacado || row.doc_sacado || "Sem identificação").trim();
        const current = grouped.get(chave);
        const exposicao = Number(row.valor_presente || 0);
        if (current) {
          current.exposicao += exposicao;
        } else {
          grouped.set(chave, {
            chave,
            nome,
            documento: row.doc_sacado || null,
            exposicao,
          });
        }
      });

      return Array.from(grouped.values()).sort((a, b) => b.exposicao - a.exposicao);
    },
  });

  const { data: regras = [], isLoading } = useQuery({
    queryKey: ["regras-compliance"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("regras_compliance")
        .select("*")
        .order("codigo");
      if (error) throw error;
      return data as RegraCompliance[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (payload: { codigo: string; descricao: string; parametros: Record<string, unknown>; fundoCnpjAssociar?: string }) => {
      const { data, error } = await supabase
        .from("regras_compliance")
        .insert({
          codigo: payload.codigo,
          descricao: payload.descricao,
          parametros: payload.parametros,
        })
        .select("id")
        .single();
      if (error) throw error;

      if (payload.fundoCnpjAssociar && data?.id) {
        const { error: assocError } = await supabase
          .from("fundo_regras")
          .upsert(
            [{ fundo_cnpj: payload.fundoCnpjAssociar, fundo_isin: "", regra_id: data.id, ativo: true }],
            { onConflict: "fundo_cnpj,fundo_isin,regra_id", ignoreDuplicates: true }
          );
        if (assocError) throw assocError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["regras-compliance"] });
      toast.success("Regra criada com sucesso!");
      resetForm();
      setDialogOpen(false);
    },
    onError: (e: any) => {
      if (e.code === "23505") toast.error("Já existe uma regra com este código.");
      else toast.error(`Erro ao criar: ${e.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload, fundoCnpjAssociar }: { id: string; payload: { descricao: string; parametros: Record<string, unknown> }; fundoCnpjAssociar?: string }) => {
      const { error } = await supabase
        .from("regras_compliance")
        .update(payload)
        .eq("id", id);
      if (error) throw error;

      if (fundoCnpjAssociar) {
        const { error: assocError } = await supabase
          .from("fundo_regras")
          .upsert(
            [{ fundo_cnpj: fundoCnpjAssociar, fundo_isin: "", regra_id: id, ativo: true }],
            { onConflict: "fundo_cnpj,fundo_isin,regra_id", ignoreDuplicates: true }
          );
        if (assocError) throw assocError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["regras-compliance"] });
      toast.success("Regra atualizada!");
      resetForm();
      setEditingId(null);
      setDialogOpen(false);
    },
    onError: (e: any) => toast.error(`Erro ao atualizar: ${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (regra: RegraCompliance) => {
      // 1. Delete associations
      await supabase.from("fundo_regras").delete().eq("regra_id", regra.id);
      
      // 2. Clear results from enquadramento_resultado for this rule (all funds)
      await supabase
        .from("enquadramento_resultado" as any)
        .delete()
        .eq("regra_codigo", regra.codigo);

      // 3. Delete the rule itself
      const { error } = await supabase
        .from("regras_compliance")
        .delete()
        .eq("id", regra.id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["regras-compliance"] });
      queryClient.invalidateQueries({ queryKey: ["fundo-regras"] });
      queryClient.invalidateQueries({ queryKey: ["enquadramento-rules"] });
      toast.success("Regra removida e resultados limpos.");
    },
    onError: (e: any) => toast.error(`Erro ao remover: ${e.message}`),
  });

  const resetForm = () => {
    setFormTipo("percentual_pl_por_categoria");
    setFormSegmentos(["COTAS"]);
    setFormCotasTipos(["Todas"]);
    setFormSectionCarteiras(["titpublico"]);
    setFormNivel1(categoriasFundo[0] ?? "");
    setFormTipoInvestidor("Profissional");
    setFormNivel1Investidor("");
    setFormMesmaAdministradora(false);
    setFormLimiteMinPct("");
    setFormLimiteMaxPct(40);
    setFormTipoFundo("");
    setFormCategoriasVedadas([]);
    setFormFundosCnpj([]);
    setBuscaFundos("");
    setFormCodigoEditavel("");
    setFormBaseCalculo("valor_presente");
    setFormUsarAbatimentoPdd(true);
    setFormOrigemPl(ORIGEM_PL_CONCENTRACAO_DEFAULT);
    setFormExcecaoFundoCnpj("");
    setFormExcecoesSacado([]);
    setBuscaSacados("");
    setFormCessaoCampo("vencimento");
    setFormCessaoModo("individual");
    setFormCessaoOperador("<=");
    setFormCessaoValorLimite(365);
    setFormCessaoUnidade("dias");
    setFormCessaoCdiVigente(14.65);
    setFormCessaoFiltroTipoRecebivel([]);
    setFormCessaoDiasReferencia(90);
    setFormCessaoDescricaoLivre("");
    setFormCessaoRefRegulamento("");
    setFormComponentes([]);
    setFormMetodoAgregacao("soma");
    setFormModoAgrupamento("por_regras");
    setFormRegrasBaseSelecionadas([]);
    setBuscaRegras("");
    setFormTribVarianteArt4("fim");
    setFormTribLimiteDias(365);
    setFormTribAlertaDias(367);
    setFormTribLimiteMm(90);
    setFormTribAlertaMm(92);
    setFormTribDenominadorElegivel(false);
    setFormTribTiposExcluidos([...TRIB_TIPOS_EXCLUIDOS_PADRAO]);
    setFormFidcClasseAlvo("senior");
    setFormFidcLimiteMin(10);
    setFormFidcLimiteAlerta(12);
    setFormFidcNumerador("jr_mez");
    setFormFidcOrigemPl(ORIGEM_PL_ESTRUTURA_DEFAULT);
    setFormFidcObservacao("");
    setFormFidcSeriesCnpj("");
    setFormFidcSeriesJr([]);
    setFormFidcSeriesMez([]);
    setFormFidcSeriesSenior([]);
  };

  useEffect(() => {
    if (dialogOpen && !editingId && categoriasFundo.length > 0 && formCotasTipos.length === 0 && formSegmentos.includes("COTAS")) {
      setFormCotasTipos(["Todas"]);
    }
  }, [dialogOpen, editingId, categoriasFundo, formCotasTipos.length, formSegmentos]);
  useEffect(() => {
    if (formSegmentos.includes("ATIVOS_FINANCEIROS") && formSectionCarteiras.length === 0) {
      setFormSectionCarteiras(["titpublico"]);
    }
  }, [formSegmentos]);

  const openEdit = (r: RegraCompliance) => {
    setEditingId(r.id);
    const p = r.parametros as Record<string, unknown>;
    const tribTipo = tipoFromCodigoTributario(r.codigo) ?? (isTipoRegraTributaria(String(p?.tipo_regra)) ? (p.tipo_regra as TipoRegra) : null);
    if (tribTipo) {
      const h = hydrateTributarioFromParametros(r.codigo, p);
      setFormTipo(tribTipo);
      setFormTribVarianteArt4(h.varianteArt4);
      setFormTribLimiteDias(h.limiteDias);
      setFormTribAlertaDias(h.alertaDias);
      setFormTribLimiteMm(h.limiteMm);
      setFormTribAlertaMm(h.alertaMm);
      setFormTribDenominadorElegivel(h.denominadorCarteiraElegivel);
      setFormTribTiposExcluidos(h.tiposExcluidos);
      setDialogOpen(true);
      return;
    }
    if (p?.tipo_regra === "classe_min") {
      setFormTipo("classe_min");
      setFormClasseTipoFundo((p.tipo_fundo as string) || "FIDC");
      const lim = p.limite as number | undefined;
      const alerta = p.limite_alerta as number | undefined;
      setFormClasseLimiteMin(lim != null ? Math.round(lim * 100) : 67);
      setFormClasseLimiteAlerta(alerta != null ? Math.round(alerta * 100) : 70);
      const secoes = p.secoes_contribuicao as string[] | undefined;
      setFormClasseSecoesAdicionais(secoes && secoes.length > 0 ? secoes : []);
      setDialogOpen(true);
      return;
    }
    if (p?.tipo_regra === "fidc_subordinacao") {
      const parsed = parseParametrosFidcSubordinacao(p);
      if (parsed) {
        setFormTipo("fidc_subordinacao");
        setFormFidcClasseAlvo(parsed.classe_alvo);
        setFormFidcLimiteMin(Math.round(parsed.limite_min * 100));
        setFormFidcLimiteAlerta(Math.round(parsed.limite_alerta * 100));
        setFormFidcNumerador(parsed.composicao_numerador);
        setFormFidcOrigemPl(parsed.origem_pl);
        setFormFidcObservacao(parsed.observacao ?? "");
        setFormFidcSeriesJr(parsed.series.jr ?? []);
        setFormFidcSeriesMez(parsed.series.mez ?? []);
        setFormFidcSeriesSenior(parsed.series.senior ?? []);
        setDialogOpen(true);
        return;
      }
    }
    if (p?.tipo_regra === "vedacao") {
      setFormTipo("vedacao");
      setFormTipoFundo((p.tipo_fundo as string) || "");
      const cats = p.categorias_vedadas as string[] | undefined;
      setFormCategoriasVedadas(cats?.length ? cats : (p.categoria_vedada ? [p.categoria_vedada as string] : []));
      setFormFundosCnpj((p.fundos_cnpj as string[]) || []);
    } else if (p?.tipo_regra === "percentual_pl_por_categoria") {
      setFormTipo("percentual_pl_por_categoria");
      const segs = p.segmentos as string[] | undefined;
      if (segs && segs.length > 0) {
        setFormSegmentos(segs.map((s) => s === "cotas" ? "COTAS" : "ATIVOS_FINANCEIROS"));
        const cats = p.nivel1_categorias as string[] | undefined;
        if (cats && cats.length > 0) {
          setFormCotasTipos(cats);
        } else if (segs.includes("cotas")) {
          setFormCotasTipos(["Todas"]);
        }
        const secs = p.section_carteiras as string[] | undefined;
        if (secs && secs.length > 0) {
          setFormSectionCarteiras(secs);
          const codprovSalvos = p.outros_provisao_codprov as string[] | undefined;
          setFormOutrosProvisaoCodprov(codprovSalvos && codprovSalvos.length > 0 ? codprovSalvos : []);
        } else if (segs.includes("ativos_financeiros")) {
          setFormSectionCarteiras([(p.section_carteira as string) || "titpublico"]);
          setFormOutrosProvisaoCodprov([]);
        }
      } else {
        const seg = p.segmento as string | undefined;
        if (seg === "ativos_financeiros" && p.section_carteira) {
          setFormSegmentos(["ATIVOS_FINANCEIROS"]);
          setFormSectionCarteiras([(p.section_carteira as string) || "titpublico"]);
        } else {
          setFormSegmentos(["COTAS"]);
          const cat = (p.nivel1_categoria as string) || "FIDC";
          setFormCotasTipos(cat === "Cotas" ? ["Todas"] : [cat]);
        }
      }
      const min = p.limite_min as number | undefined;
      const max = p.limite_max as number | undefined;
      const legado = p.limite as number | undefined;
      setFormLimiteMinPct(min != null ? Math.round(min * 100) : "");
      setFormLimiteMaxPct(max != null ? Math.round(max * 100) : (legado != null ? Math.round(legado * 100) : 40));
    } else if (
      p?.tipo_regra === "CONCENTRACAO_DEVEDOR" ||
      p?.tipo_regra === "CONCENTRACAO_CEDENTE" ||
      p?.tipo_regra === "CONCENTRACAO_SEM_COOBRIGACAO"
    ) {
      setFormTipo(p.tipo_regra as TipoRegra);
      setFormBaseCalculo((p.base_calculo as string) || "valor_presente");
      setFormUsarAbatimentoPdd((p.usar_abatimento_pdd as boolean) ?? true);
      setFormOrigemPl((p.origem_pl as string) || ORIGEM_PL_CONCENTRACAO_DEFAULT);
      const min = p.limite_min as number | undefined;
      const max = p.limite_max as number | undefined;
      setFormLimiteMinPct(min != null ? Math.round(min * 100) : "");
      setFormLimiteMaxPct(max != null ? Math.round(max * 100) : 5);
      const fundoExcecao = (p.fundo_excecao_cnpj as string) || "";
      const mapaExcecoes = (p.excecoes_sacado_por_fundo as Record<string, any[]> | undefined) || {};
      const excecoes = fundoExcecao && Array.isArray(mapaExcecoes[fundoExcecao]) ? mapaExcecoes[fundoExcecao] : [];
      setFormExcecaoFundoCnpj(fundoExcecao);
      setFormExcecoesSacado(
        excecoes.map((item) => ({
          chave: String(item.chave || ""),
          nome: String(item.nome || item.documento || "Sem identificação"),
          documento: item.documento ? String(item.documento) : null,
          modo: item.modo === "limite_customizado" ? "limite_customizado" : "ignorar",
          limiteMaxPct: item.limite_max != null ? Math.round(Number(item.limite_max) * 100) : "",
        }))
      );
    } else if (p?.tipo_regra === "CESSAO_CONDICAO") {
      setFormTipo("CESSAO_CONDICAO");
      const campoC = (p.campo as string) || "vencimento";
      const unidC = (p.unidade as string) || "dias";
      setFormCessaoCampo(campoC);
      setFormCessaoModo((p.modo as string) || "individual");
      let opC = (p.operador as string) || "<=";
      if (campoC === "taxa_cessao" && unidC === "percentual_cdi" && opC !== ">=") {
        opC = ">=";
      }
      setFormCessaoOperador(opC);
      setFormCessaoValorLimite(p.valor_limite != null ? Number(p.valor_limite) : "");
      setFormCessaoUnidade(unidC);
      setFormCessaoCdiVigente(p.cdi_vigente_aa != null ? Number(p.cdi_vigente_aa) : 14.65);
      setFormCessaoFiltroTipoRecebivel(Array.isArray(p.filtro_tipo_recebivel) ? (p.filtro_tipo_recebivel as string[]) : []);
      setFormCessaoDiasReferencia(p.dias_referencia != null ? Number(p.dias_referencia) : 90);
      setFormCessaoDescricaoLivre((p.descricao_livre as string) || "");
      setFormCessaoRefRegulamento((p.ref_regulamento as string) || "");
    } else if (p?.tipo_regra === "CESSAO_CADASTRO_PARTES") {
      setFormTipo("CESSAO_CADASTRO_PARTES");
      setFormCadVerificarCedente(p.verificar_cedente !== false);
      setFormCadVerificarSacado(p.verificar_sacado === true);
      setFormCadPoliticaNaoCadastrado((p.politica_nao_cadastrado as PoliticaCadastro) ?? "vedar");
      setFormCadPoliticaVencido((p.politica_cadastro_vencido as PoliticaCadastro) ?? "vedar");
      setFormCadPoliticaPendente((p.politica_revisao_pendente as PoliticaCadastro) ?? "alertar");
      setFormCadValidadeInclusiva(p.validade_inclusiva !== false);
      setFormBaseCalculo((p.base_calculo as string) || "valor_presente");
      setFormUsarAbatimentoPdd(p.usar_abatimento_pdd !== false);
    } else if (p?.tipo_regra === "agrupamento_conjunto") {
      setFormTipo("agrupamento_conjunto");
      const max = p.limite_max as number | undefined;
      setFormLimiteMaxPct(max != null ? Math.round(max * 100) : 40);
      setFormMetodoAgregacao((p.metodo_agregacao as string) || "soma");
      const modo = (p.modo as ModoAgrupamento) || "por_componentes";
      setFormModoAgrupamento(modo);
      
      if (modo === "por_regras" && p.regras_base) {
        setFormRegrasBaseSelecionadas(p.regras_base as string[]);
      } else {
        const comps = p.componentes as any[] | undefined;
        if (comps && Array.isArray(comps)) {
          setFormComponentes(comps.map((c, i) => ({
            id: `comp-${i}`,
            tipo: c.tipo === 'categoria' ? 'cotas' : c.tipo === 'secao_carteira' ? 'ativos_financeiros' : c.tipo || "cotas",
            valor: c.valor || "",
            peso: c.peso || 1.0
          })));
        }
      }
    } else {
      setFormTipo("limite_por_tipo_investidor");
      setFormTipoInvestidor((p?.tipo_investidor as string) || "Profissional");
      setFormNivel1Investidor((p?.nivel1_categoria as string) || "");
      setFormMesmaAdministradora((p?.mesma_administradora as boolean) || false);
      const legado = p?.limite as number | undefined;
      setFormLimiteMinPct("");
      setFormLimiteMaxPct(legado != null ? Math.round(legado * 100) : 10);
    }
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    // Para classe_min os limites vêm de estados próprios
    const minVal = formTipo === "classe_min"
      ? (typeof formClasseLimiteMin === "number" ? formClasseLimiteMin : undefined)
      : (typeof formLimiteMinPct === "number" ? formLimiteMinPct : undefined);
    const maxVal = formTipo === "classe_min"
      ? (typeof formClasseLimiteAlerta === "number" ? formClasseLimiteAlerta : undefined)
      : (typeof formLimiteMaxPct === "number" ? formLimiteMaxPct : undefined);

    const nivel1ParaRegra = formTipo === "percentual_pl_por_categoria" && formSegmentos.includes("COTAS")
      ? (formCotasTipos.includes("Todas") || formCotasTipos.length === 0 ? "Cotas" : formCotasTipos[0])
      : formNivel1;
    const isConcentracaoFidc =
      formTipo === "CONCENTRACAO_DEVEDOR" ||
      formTipo === "CONCENTRACAO_CEDENTE" ||
      formTipo === "CONCENTRACAO_SEM_COOBRIGACAO";

    const parametros = isTipoRegraTributaria(formTipo)
      ? formTipo === "tributario_prazo_medio_art4"
        ? buildParametrosTributarioArt4(formTribVarianteArt4, formTribLimiteDias, formTribAlertaDias)
        : buildParametrosTributarioArt5(
            formTribDenominadorElegivel,
            formTribTiposExcluidos,
            formTribLimiteMm,
            formTribAlertaMm,
          )
      : formTipo === "fidc_subordinacao"
      ? buildParametrosSubordinacao({
          classeAlvo: formFidcClasseAlvo,
          limiteMinPct: typeof formFidcLimiteMin === "number" ? formFidcLimiteMin : 10,
          limiteAlertaPct: typeof formFidcLimiteAlerta === "number" ? formFidcLimiteAlerta : 12,
          composicaoNumerador: formFidcNumerador,
          origemPl: formFidcOrigemPl as "pl_atual_xml" | "pl_mes_anterior_posicao",
          series: {
            jr: formFidcSeriesJr,
            mez: formFidcSeriesMez,
            senior: formFidcSeriesSenior,
          },
          observacao: formFidcObservacao,
        })
      : formTipo === "CESSAO_CONDICAO"
      ? (() => {
          const p: Record<string, unknown> = {
            tipo_regra: "CESSAO_CONDICAO",
            campo: formCessaoCampo,
            modo: formCessaoModo,
            operador:
              formCessaoCampo === "taxa_cessao" && formCessaoUnidade === "percentual_cdi"
                ? ">="
                : formCessaoOperador,
            unidade: formCessaoUnidade,
          };
          if (formCessaoValorLimite !== "") p.valor_limite = formCessaoValorLimite;
          if (formCessaoUnidade === "percentual_cdi" && typeof formCessaoCdiVigente === "number") {
            p.cdi_vigente_aa = formCessaoCdiVigente;
          }
          if (formCessaoCampo === "exposicao_prazo_acima" && formCessaoDiasReferencia !== "") p.dias_referencia = formCessaoDiasReferencia;
          if (formCessaoCampo === "substituicao_unica") {
            p.tipos_permitidos = ["duplicata", "ccb", "nota comercial", "cce"];
          }
          if (formCessaoFiltroTipoRecebivel.length > 0) p.filtro_tipo_recebivel = formCessaoFiltroTipoRecebivel;
          if (formCessaoDescricaoLivre.trim()) p.descricao_livre = formCessaoDescricaoLivre.trim();
          if (formCessaoRefRegulamento.trim()) p.ref_regulamento = formCessaoRefRegulamento.trim();
          return p;
        })()
      : formTipo === "CESSAO_CADASTRO_PARTES"
      ? {
          tipo_regra: "CESSAO_CADASTRO_PARTES",
          verificar_cedente: formCadVerificarCedente,
          verificar_sacado: formCadVerificarSacado,
          base_calculo: formBaseCalculo,
          usar_abatimento_pdd: formUsarAbatimentoPdd,
          usar_grupo_economico: true,
          politica_nao_cadastrado: formCadPoliticaNaoCadastrado,
          politica_cadastro_vencido: formCadPoliticaVencido,
          politica_revisao_pendente: formCadPoliticaPendente,
          validade_inclusiva: formCadValidadeInclusiva,
        }
      : buildParametros(
          formTipo,
          formTipo === "percentual_pl_por_categoria" ? nivel1ParaRegra : formNivel1,
          formTipo === "limite_por_tipo_investidor" ? formTipoInvestidor : undefined,
          minVal,
          maxVal,
          formTipo === "vedacao" ? formTipoFundo || undefined
            : formTipo === "classe_min" ? formClasseTipoFundo
            : undefined,
          formTipo === "vedacao" && formCategoriasVedadas.length === 1 ? formCategoriasVedadas[0] : undefined,
          formTipo === "limite_por_tipo_investidor" && formNivel1Investidor ? formNivel1Investidor : undefined,
          formSegmentos.length === 1 ? (formSegmentos[0] as "COTAS" | "ATIVOS_FINANCEIROS") : undefined,
          formSegmentos.length === 1 && formSegmentos[0] === "ATIVOS_FINANCEIROS" ? formSectionCarteiras[0] : undefined,
          formTipo === "percentual_pl_por_categoria" && formSegmentos.length > 0 ? formSegmentos : undefined,
          formTipo === "percentual_pl_por_categoria" && formSegmentos.includes("COTAS") ? formCotasTipos : undefined,
          formTipo === "percentual_pl_por_categoria" && formSegmentos.includes("ATIVOS_FINANCEIROS") ? formSectionCarteiras : undefined,
          formTipo === "vedacao" ? formCategoriasVedadas : undefined,
          formTipo === "vedacao" ? formFundosCnpj : undefined,
          formTipo === "limite_por_tipo_investidor" ? formMesmaAdministradora : undefined,
          isConcentracaoFidc ? formBaseCalculo : undefined,
          formTipo === "CONCENTRACAO_DEVEDOR" ? formExcecaoFundoCnpj || undefined : undefined,
          formTipo === "CONCENTRACAO_DEVEDOR" ? formExcecoesSacado : undefined,
          isConcentracaoFidc ? formUsarAbatimentoPdd : undefined,
          isConcentracaoFidc ? formOrigemPl : undefined,
          formTipo === "agrupamento_conjunto" ? formComponentes : undefined,
          formTipo === "agrupamento_conjunto" ? formMetodoAgregacao : undefined,
          formTipo === "agrupamento_conjunto" ? formModoAgrupamento : undefined,
          formTipo === "agrupamento_conjunto" ? formRegrasBaseSelecionadas : undefined,
          formSectionCarteiras.includes("outros") ? formOutrosProvisaoCodprov : undefined,
          formTipo === "classe_min" ? formClasseSecoesAdicionais : undefined,
        );
    const codigoGerado = isTipoRegraTributaria(formTipo)
      ? codigoFromTributario(formTipo, formTribVarianteArt4)
      : formTipo === "CESSAO_CONDICAO"
      ? formCessaoCampo === "substituicao_unica"
        ? "CESSAO_SUBST_UNICA"
        : `CESSAO_${formCessaoCampo.toUpperCase()}_${formCessaoValorLimite !== "" ? formCessaoValorLimite : "0"}`
      : formTipo === "CESSAO_CADASTRO_PARTES"
      ? "CESSAO_CADASTRO_PARTES"
      : formTipo === "classe_min"
      ? buildCodigoClasseMin(formClasseTipoFundo, formClasseLimiteMin)
      : formTipo === "fidc_subordinacao"
      ? buildCodigoSubordinacao(formFidcClasseAlvo, formFidcLimiteMin || 10)
      : buildCodigo(
          formTipo,
          nivel1ParaRegra,
          minVal,
          maxVal,
          formTipoFundo || undefined,
          formCategoriasVedadas.length === 1 ? formCategoriasVedadas[0] : undefined,
          formTipoInvestidor,
          formNivel1Investidor || undefined,
          formSegmentos.length === 1 ? formSegmentos[0] as "COTAS" | "ATIVOS_FINANCEIROS" : undefined,
          formSegmentos.length === 1 && formSegmentos[0] === "ATIVOS_FINANCEIROS" ? formSectionCarteiras[0] : undefined,
          formSegmentos,
          formCotasTipos,
          formSectionCarteiras,
          formCategoriasVedadas,
          formFundosCnpj,
          formTipo === "limite_por_tipo_investidor" ? formMesmaAdministradora : undefined,
          formTipo === "agrupamento_conjunto" ? formComponentes : undefined,
          formTipo === "agrupamento_conjunto" ? formRegrasBaseSelecionadas : undefined
        );
    const codigo = editingId
      ? (regras.find((r) => r.id === editingId)?.codigo ?? "")
      : (formCodigoEditavel.trim() || codigoGerado);
    const descricao = isTipoRegraTributaria(formTipo)
      ? buildDescricaoTributario(
          formTipo,
          formTribVarianteArt4,
          formTribLimiteDias,
          formTribLimiteMm,
          formTribDenominadorElegivel,
          formTribTiposExcluidos,
        )
      : formTipo === "CESSAO_CONDICAO"
      ? (formCessaoDescricaoLivre.trim() || (() => {
          const filtro = formCessaoFiltroTipoRecebivel.length > 0 ? ` [${formCessaoFiltroTipoRecebivel.join(", ")}]` : "";
          if (
            formCessaoCampo === "taxa_cessao_implicita" &&
            formCessaoUnidade === "percentual_cdi" &&
            typeof formCessaoCdiVigente === "number" &&
            typeof formCessaoValorLimite === "number"
          ) {
            return `Taxa implícita mínima do lote (por cedente) ≥ ${formCessaoValorLimite}% do CDI vigente (${formCessaoCdiVigente}% a.a.)${filtro}`;
          }
          if (
            formCessaoCampo === "taxa_cessao" &&
            formCessaoUnidade === "percentual_cdi" &&
            typeof formCessaoCdiVigente === "number" &&
            typeof formCessaoValorLimite === "number"
          ) {
            const minAa = (formCessaoCdiVigente * formCessaoValorLimite) / 100;
            return `Taxa de cessão declarada (TX_CESSAO) ≥ ${formCessaoValorLimite}% do CDI (${formCessaoCdiVigente}% a.a.) — mín. ${minAa.toFixed(2)}% a.a.${filtro}`;
          }
          const campoLabel = CESSAO_CAMPOS.find(c => c.value === formCessaoCampo)?.label || formCessaoCampo;
          const opLabel = CESSAO_OPERADORES.find(o => o.value === formCessaoOperador)?.label || formCessaoOperador;
          const unLabel = CESSAO_UNIDADES.find(u => u.value === formCessaoUnidade)?.label || formCessaoUnidade;
          return `${campoLabel} ${opLabel} ${formCessaoValorLimite} ${unLabel}${filtro}`;
        })())
      : formTipo === "CESSAO_CADASTRO_PARTES"
      ? "Cadastro de partes — vigência de cedentes/sacados e limite de comitê"
      : formTipo === "classe_min"
      ? buildDescricao("classe_min", undefined, undefined, formClasseLimiteMin !== "" ? formClasseLimiteMin : undefined, formClasseLimiteAlerta !== "" ? formClasseLimiteAlerta : undefined, formClasseTipoFundo)
      : formTipo === "fidc_subordinacao"
      ? buildDescricaoSubordinacao(
          formFidcClasseAlvo,
          typeof formFidcLimiteMin === "number" ? formFidcLimiteMin : 10,
          typeof formFidcLimiteAlerta === "number" ? formFidcLimiteAlerta : 12,
          formFidcNumerador,
          formFidcObservacao,
        )
      : buildDescricao(
          formTipo,
          nivel1ParaRegra,
          formTipoInvestidor,
          minVal,
          maxVal,
          formTipoFundo || undefined,
          formCategoriasVedadas.length === 1 ? formCategoriasVedadas[0] : undefined,
          formNivel1Investidor || undefined,
          formSegmentos.length === 1 ? formSegmentos[0] as "COTAS" | "ATIVOS_FINANCEIROS" : undefined,
          formSegmentos.length === 1 && formSegmentos[0] === "ATIVOS_FINANCEIROS" ? formSectionCarteiras[0] : undefined,
          formSegmentos,
          formCotasTipos,
          formSectionCarteiras,
          formCategoriasVedadas,
          formFundosCnpj,
          formTipo === "limite_por_tipo_investidor" ? formMesmaAdministradora : undefined,
          formTipo === "agrupamento_conjunto" ? formComponentes : undefined,
          formTipo === "agrupamento_conjunto" ? formRegrasBaseSelecionadas : undefined
        );

    if (formTipo === "classe_min") {
      if (!formClasseTipoFundo) { toast.error("Selecione o tipo de fundo (FIDC, FII ou FIP)."); return; }
      if (formClasseLimiteMin === "" || formClasseLimiteMin <= 0 || formClasseLimiteMin >= 100) {
        toast.error("Informe o limite mínimo válido (1–99%)."); return;
      }
    }
    if (formTipo === "fidc_subordinacao") {
      const allIsins = [...formFidcSeriesJr, ...formFidcSeriesMez, ...formFidcSeriesSenior];
      if (allIsins.length === 0) {
        toast.error("Configure ao menos um ISIN em series (JR, MEZ ou Sênior).");
        return;
      }
      if (formFidcClasseAlvo === "senior" && formFidcSeriesSenior.length === 0) {
        toast.error("Para subordinação sênior, informe ao menos um ISIN em Sênior.");
        return;
      }
      if (formFidcClasseAlvo === "mezanino" && formFidcSeriesMez.length === 0) {
        toast.error("Para subordinação mezanino, informe ao menos um ISIN em Mezanino.");
        return;
      }
      if (formFidcLimiteMin === "" || formFidcLimiteMin <= 0 || formFidcLimiteMin >= 100) {
        toast.error("Informe o percentual mínimo válido (1–99%).");
        return;
      }
      if (
        formFidcLimiteAlerta !== "" &&
        (formFidcLimiteAlerta <= 0 ||
          formFidcLimiteAlerta >= 100 ||
          (typeof formFidcLimiteMin === "number" && formFidcLimiteAlerta < formFidcLimiteMin))
      ) {
        toast.error("O percentual de alerta deve estar entre o mínimo e 99%.");
        return;
      }
    }
    if (formTipo === "percentual_pl_por_categoria" && formSegmentos.length === 0) {
      toast.error("Selecione pelo menos um segmento (Cotas ou Ativos Financeiros).");
      return;
    }
    if (formTipo === "percentual_pl_por_categoria" && formSegmentos.includes("ATIVOS_FINANCEIROS") && formSectionCarteiras.length === 0) {
      toast.error("Selecione pelo menos uma section da carteira para Ativos Financeiros.");
      return;
    }
    if (formTipo === "vedacao") {
      if (!formTipoFundo && formFundosCnpj.length === 0) {
        toast.error("Selecione pelo menos um tipo de fundo ou fundos específicos. A regra não será aplicada até que um seja definido.");
        return;
      }
      if (formCategoriasVedadas.length === 0) {
        toast.error("Selecione pelo menos uma categoria vedada.");
        return;
      }
    }
    if (isConcentracaoFidc && (minVal == null && maxVal == null)) {
      toast.error("Informe pelo menos um limite (mínimo ou máximo) para a regra de concentração.");
      return;
    }
    if (formTipo === "CESSAO_CONDICAO") {
      if (formCessaoCampo !== "vencimento" && formCessaoCampo !== "tipo_recebivel" && formCessaoValorLimite === "") {
        toast.error("Informe o valor limite para a condição de cessão.");
        return;
      }
      if (formCessaoUnidade === "percentual_cdi" && (typeof formCessaoCdiVigente !== "number" || formCessaoCdiVigente <= 0)) {
        toast.error("Informe o CDI vigente (% a.a.).");
        return;
      }
    }
    if (formTipo === "CONCENTRACAO_DEVEDOR" && formExcecoesSacado.length > 0 && !formExcecaoFundoCnpj) {
      toast.error("Selecione o fundo ao qual as exceções por sacado pertencem.");
      return;
    }
    if (formTipo === "CONCENTRACAO_DEVEDOR" && formExcecoesSacado.some((item) => item.modo === "limite_customizado" && item.limiteMaxPct === "")) {
      toast.error("Preencha o limite máximo para todos os sacados com exceção personalizada.");
      return;
    }
    if (isTipoRegraTributaria(formTipo)) {
      if (formTribLimiteDias <= 0 || formTribAlertaDias <= 0) {
        toast.error("Informe limites de prazo válidos (dias).");
        return;
      }
      if (formTipo === "tributario_fiq_art5" && formTribTiposExcluidos.length === 0) {
        toast.error("Selecione pelo menos um tipo de cota excluído.");
        return;
      }
    }
    if (!editingId && codigo && regras.some((r) => r.codigo === codigo)) {
      toast.error("Já existe uma regra com este código.");
      return;
    }
    if (!codigo || !descricao) {
      toast.error(
        formTipo === "vedacao" || isTipoRegraTributaria(formTipo)
          ? "Preencha os campos."
          : "Preencha pelo menos um limite (mínimo ou máximo).",
      );
      return;
    }

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        payload: { descricao, parametros },
        fundoCnpjAssociar: formTipo === "CONCENTRACAO_DEVEDOR" && formExcecaoFundoCnpj ? formExcecaoFundoCnpj : undefined,
      });
    } else {
      createMutation.mutate({
        codigo,
        descricao,
        parametros,
        fundoCnpjAssociar: formTipo === "CONCENTRACAO_DEVEDOR" && formExcecaoFundoCnpj ? formExcecaoFundoCnpj : undefined,
      });
    }
  };

  const regrasFiltradas = regras.filter(
    (r) =>
      r.codigo.toLowerCase().includes(busca.toLowerCase()) ||
      r.descricao.toLowerCase().includes(busca.toLowerCase())
  );

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col gap-1 border-b border-border pb-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase tracking-wider flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Regras de Compliance
          </h1>
          <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">
            Crie e gerencie regras que poderão ser associadas aos fundos em Regras Relacionais.
          </p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <div>
              <CardTitle className="text-lg">Catálogo de Regras</CardTitle>
              <CardDescription>Todas as regras cadastradas no sistema.</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar por código ou descrição..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
              <Dialog open={dialogOpen} onOpenChange={(open) => {
                setDialogOpen(open);
                if (!open) {
                  setEditingId(null);
                  resetForm();
                }
              }}>
                <DialogTrigger asChild>
                  <Button className="gap-2">
                    <Plus className="h-4 w-4" />
                    Nova Regra
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden">
                  <DialogHeader>
                    <DialogTitle>{editingId ? "Editar Regra" : "Nova Regra"}</DialogTitle>
                    <DialogDescription>
                      Configure a regra de enquadramento. Os parâmetros definem como a verificação será feita.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="max-h-[72vh] overflow-y-auto pr-1">
                  <div className="grid gap-4 py-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase">Tipo de Regra</Label>
                      <Select
                        value={formTipo}
                        onValueChange={(v) => {
                          setFormTipo(v as TipoRegra);
                          setFormCodigoEditavel("");
                        }}
                        disabled={!!editingId}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="percentual_pl_por_categoria">
                            Limite % PL por categoria (FIDC, FII, FIP, Cotas, etc.)
                          </SelectItem>
                          <SelectItem value="vedacao">
                            Vedação (ex: FIDC não pode ter cotas de Multimercados)
                          </SelectItem>
                          <SelectItem value="limite_por_tipo_investidor">
                            Limite % PL por tipo de investidor
                          </SelectItem>
                          <SelectItem value="CONCENTRACAO_DEVEDOR">
                            Concentração FIDC — mesmo Devedor (Sacado)
                          </SelectItem>
                          <SelectItem value="CONCENTRACAO_CEDENTE">
                            Concentração FIDC — mesmo Cedente e/ou Emissor
                          </SelectItem>
                          <SelectItem value="CONCENTRACAO_SEM_COOBRIGACAO">
                            Concentração FIDC — sem Coobrigação dos Cedentes
                          </SelectItem>
                          <SelectItem value="CESSAO_CADASTRO_PARTES">
                            Cadastro de Partes — limite comitê (ativador)
                          </SelectItem>
                          <SelectItem value="CESSAO_CONDICAO">
                            Condição de Cessão / Elegibilidade (genérica)
                          </SelectItem>
                          <SelectItem value="agrupamento_conjunto">
                            Agrupamento Conjunto (soma múltiplas exposições)
                          </SelectItem>
                          <SelectItem value="classe_min">
                            Classe — Mínimo % investimento (FIDC ≥ 67% / FII ≥ 67% / FIP ≥ 90%)
                          </SelectItem>
                          <SelectItem value="fidc_subordinacao">
                            FIDC — Subordinação multiclasse (JR / MEZ / PL Classe)
                          </SelectItem>
                          <SelectItem value="tributario_prazo_medio_art4">
                            Tributário — Art. 4º prazo médio (FIM / FIDC)
                          </SelectItem>
                          <SelectItem value="tributario_fiq_art5">
                            Tributário — Art. 5º FIQ (MM-10d % LP)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {!editingId && (
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase">Código (editável)</Label>
                        <Input
                          className="font-mono text-xs"
                          placeholder={
                            isTipoRegraTributaria(formTipo)
                              ? codigoFromTributario(formTipo, formTribVarianteArt4)
                              : "Ex: LIMITE_MAX_FIDC_40"
                          }
                          value={
                            formCodigoEditavel !== ""
                              ? formCodigoEditavel
                              : isTipoRegraTributaria(formTipo)
                              ? codigoFromTributario(formTipo, formTribVarianteArt4)
                              : formTipo === "classe_min"
                              ? buildCodigoClasseMin(formClasseTipoFundo, formClasseLimiteMin)
                              : formTipo === "fidc_subordinacao"
                              ? buildCodigoSubordinacao(formFidcClasseAlvo, formFidcLimiteMin || 10)
                              : buildCodigo(
                                  formTipo,
                                  formTipo === "percentual_pl_por_categoria" && formSegmentos.includes("COTAS")
                                    ? (formCotasTipos.includes("Todas") || formCotasTipos.length === 0 ? "Cotas" : formCotasTipos[0])
                                    : formNivel1 || categoriasFundo[0],
                                  typeof formLimiteMinPct === "number" ? formLimiteMinPct : undefined,
                                  typeof formLimiteMaxPct === "number" ? formLimiteMaxPct : undefined,
                                  formTipoFundo || undefined,
                                  formCategoriasVedadas.length === 1 ? formCategoriasVedadas[0] : undefined,
                                  formTipoInvestidor,
                                  formNivel1Investidor || undefined,
                                  formSegmentos.length === 1 ? formSegmentos[0] as "COTAS" | "ATIVOS_FINANCEIROS" : undefined,
                                  formSegmentos.length === 1 && formSegmentos[0] === "ATIVOS_FINANCEIROS" ? formSectionCarteiras[0] : undefined,
                                  formSegmentos,
                                  formCotasTipos,
                                  formSectionCarteiras,
                                  formCategoriasVedadas,
                                  formFundosCnpj,
                                  formTipo === "limite_por_tipo_investidor" ? formMesmaAdministradora : undefined,
                                  formTipo === "agrupamento_conjunto" ? formComponentes : undefined,
                                  formTipo === "agrupamento_conjunto" ? formRegrasBaseSelecionadas : undefined
                                ) || ""
                          }
                          onChange={(e) => setFormCodigoEditavel(e.target.value)}
                        />
                        <p className="text-[10px] text-muted-foreground">
                          {isTipoRegraTributaria(formTipo)
                            ? "Sugestão regulatória pré-preenchida (ex.: TRIB_FIQ_LP_90). Edite para personalizar."
                            : "Edite para personalizar. Deixe vazio para usar o código gerado automaticamente."}
                        </p>
                      </div>
                    )}
                    {formTipo === "classe_min" && (
                      <div className="space-y-4 border rounded-md p-4 bg-violet-50/40 border-violet-200/60">
                        <p className="text-xs text-muted-foreground">
                          Define o percentual mínimo do PL que o fundo deve manter investido na sua classe principal
                          (ex.: FIDC ≥ 67%). A regra substitui o padrão automático <span className="font-mono">CLASSE_FIDC_67</span> quando
                          associada ao fundo.
                        </p>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Tipo de Fundo</Label>
                          <Select
                            value={formClasseTipoFundo}
                            onValueChange={setFormClasseTipoFundo}
                            disabled={!!editingId}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="FIDC">FIDC — Direitos Creditórios (mín. padrão 67%)</SelectItem>
                              <SelectItem value="FII">FII — Imobiliário (mín. padrão 67%)</SelectItem>
                              <SelectItem value="FIP">FIP — Participações (mín. padrão 90%)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Limite mínimo (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              value={formClasseLimiteMin}
                              onChange={(e) =>
                                setFormClasseLimiteMin(e.target.value === "" ? "" : Number(e.target.value))
                              }
                              placeholder="67"
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Descumprimento acima deste valor gera alerta/desenquadramento.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Alerta (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={100}
                              value={formClasseLimiteAlerta}
                              onChange={(e) =>
                                setFormClasseLimiteAlerta(e.target.value === "" ? "" : Number(e.target.value))
                              }
                              placeholder="70"
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Zona de alerta preventivo (acima do mínimo). Deixe 0 para desativar.
                            </p>
                          </div>
                        </div>
                        {/* Seções adicionais que compõem o numerador */}
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">
                            Seções adicionais na composição do investimento
                          </Label>
                          <p className="text-[10px] text-muted-foreground">
                            Por padrão são contados: ativos da seção <span className="font-mono">fidc</span>,
                            cotas de FIDCs e provisões <span className="font-mono">codprov=999/credeb=C</span>.
                            Selecione abaixo outras seções a incluir no numerador (ex.: títulos privados usados como DC).
                          </p>
                          <div className="border rounded-md p-3 bg-background space-y-2">
                            {[
                              { value: "titprivado", label: "Títulos Privados (CRI, LCI, CCB, etc.)" },
                              { value: "titpublico", label: "Títulos Públicos (LFT, LTN, etc.)" },
                              { value: "debenture", label: "Debêntures" },
                              { value: "cotas_fidc", label: "Cotas de FIDCs (section cotas, tipo FIDC)" },
                              { value: "outros", label: "Outros (section outros/provisão)" },
                            ].map((s) => (
                              <label key={s.value} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={formClasseSecoesAdicionais.includes(s.value)}
                                  onCheckedChange={(checked) => {
                                    if (checked) {
                                      setFormClasseSecoesAdicionais((prev) => [...prev, s.value]);
                                    } else {
                                      setFormClasseSecoesAdicionais((prev) => prev.filter((v) => v !== s.value));
                                    }
                                  }}
                                />
                                <span className="text-sm">{s.label}</span>
                              </label>
                            ))}
                          </div>
                          {formClasseSecoesAdicionais.length > 0 && (
                            <p className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded p-2">
                              Seções selecionadas serão somadas aos ativos padrão no cálculo do{" "}
                              {formClasseLimiteMin || "?"}% mínimo.
                            </p>
                          )}
                        </div>

                        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                          Ao associar esta regra ao fundo, ela sobrescreve o parâmetro da regra automática{" "}
                          <span className="font-mono">CLASSE_{formClasseTipoFundo}_{formClasseLimiteMin || "?"}</span>{" "}
                          para esse fundo específico.
                        </p>
                      </div>
                    )}
                    {formTipo === "fidc_subordinacao" && (
                      <div className="space-y-4 border rounded-md p-4 bg-sky-50/40 border-sky-200/60">
                        <p className="text-xs text-muted-foreground">
                          Monitora subordinação sobre <strong>PL Classe</strong> (soma das subclasses).
                          A verificação roda <strong>somente na subclasse alvo</strong> (associe em Regras Relacionais com o ISIN da SR ou MEZ).
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Classe alvo</Label>
                            <Select
                              value={formFidcClasseAlvo}
                              onValueChange={(v) => {
                                const alvo = v as ClasseAlvoSubordinacao;
                                setFormFidcClasseAlvo(alvo);
                                setFormFidcNumerador(alvo === "mezanino" ? "jr" : "jr_mez");
                              }}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="senior">Sênior — (JR + MEZ) / PL Classe</SelectItem>
                                <SelectItem value="mezanino">Mezanino — JR / PL Classe</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Numerador</Label>
                            <Select
                              value={formFidcNumerador}
                              onValueChange={(v) => setFormFidcNumerador(v as ComposicaoNumeradorSubordinacao)}
                              disabled={formFidcClasseAlvo === "mezanino"}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="jr_mez">JR + MEZ</SelectItem>
                                <SelectItem value="jr">Somente JR</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Mínimo (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              value={formFidcLimiteMin}
                              onChange={(e) =>
                                setFormFidcLimiteMin(e.target.value === "" ? "" : Number(e.target.value))
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Alerta (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              value={formFidcLimiteAlerta}
                              onChange={(e) =>
                                setFormFidcLimiteAlerta(e.target.value === "" ? "" : Number(e.target.value))
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Origem do PL</Label>
                          <Select value={formFidcOrigemPl} onValueChange={setFormFidcOrigemPl}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pl_mes_anterior_posicao">
                                PL mês anterior (posição — recomendado)
                              </SelectItem>
                              <SelectItem value="pl_atual_xml">PL do dia (XML)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">CNPJ do fundo (carregar subclasses)</Label>
                          <Input
                            className="font-mono text-xs"
                            placeholder="36.517.586/0001-03"
                            value={formFidcSeriesCnpj}
                            onChange={(e) => setFormFidcSeriesCnpj(e.target.value)}
                          />
                        </div>
                        {fidcSubclasses.length > 0 && (
                          <div className="space-y-2 border rounded-md p-3 bg-background">
                            <Label className="text-xs font-bold uppercase">Series (ISIN por papel)</Label>
                            {fidcSubclasses.map((sub) => (
                              <div key={sub.key} className="flex flex-wrap items-center gap-2 py-1 border-b border-border/40 last:border-0">
                                <span className="text-xs font-medium flex-1 min-w-[140px]">{sub.nome}</span>
                                <span className="text-[10px] font-mono text-muted-foreground">{sub.isin || "sem ISIN"}</span>
                                {(["jr", "mez", "senior"] as const).map((papel) => (
                                  <Button
                                    key={papel}
                                    type="button"
                                    size="sm"
                                    variant={fidcSeriesPapel(sub.isin) === papel ? "default" : "outline"}
                                    className="h-7 text-[10px] uppercase"
                                    onClick={() => sub.isin && toggleFidcSeriesIsin(sub.isin, papel)}
                                    disabled={!sub.isin}
                                  >
                                    {papel}
                                  </Button>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-muted-foreground">
                          <div>JR: {formFidcSeriesJr.join(", ") || "—"}</div>
                          <div>MEZ: {formFidcSeriesMez.join(", ") || "—"}</div>
                          <div>SR: {formFidcSeriesSenior.join(", ") || "—"}</div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Observação regulamentar</Label>
                          <Input
                            value={formFidcObservacao}
                            onChange={(e) => setFormFidcObservacao(e.target.value)}
                            placeholder="Ex: Item 13.1 I do Regulamento"
                          />
                        </div>
                      </div>
                    )}
                    {formTipo === "tributario_prazo_medio_art4" && (
                      <>
                        {!editingId && (
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Variante Art. 4º</Label>
                            <Select
                              value={formTribVarianteArt4}
                              onValueChange={(v) => {
                                setFormTribVarianteArt4(v as VarianteArt4);
                                setFormCodigoEditavel("");
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="fim">FIM — carteira (cotas + títulos RF)</SelectItem>
                                <SelectItem value="fidc">FIDC — estoque de recebíveis</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Limite prazo médio (dias)</Label>
                            <Input
                              type="number"
                              min={1}
                              value={formTribLimiteDias}
                              onChange={(e) => setFormTribLimiteDias(Number(e.target.value) || 365)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Alerta (dias)</Label>
                            <Input
                              type="number"
                              min={1}
                              value={formTribAlertaDias}
                              onChange={(e) => setFormTribAlertaDias(Number(e.target.value) || 367)}
                            />
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          LP tributário quando prazo médio ponderado &gt; {formTribLimiteDias} dias (IN RFB 1585/2015 Art. 4º).
                        </p>
                      </>
                    )}
                    {formTipo === "tributario_fiq_art5" && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Mínimo MM-10d (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={100}
                              value={formTribLimiteMm}
                              onChange={(e) => setFormTribLimiteMm(Number(e.target.value) || 90)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Faixa alerta (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={100}
                              value={formTribAlertaMm}
                              onChange={(e) => setFormTribAlertaMm(Number(e.target.value) || 92)}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">
                            Tipos de cota excluídos (não contam como LP)
                          </Label>
                          <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                            {tiposExcluidosArt5Opcoes.map((c) => (
                              <label key={c} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={formTribTiposExcluidos.includes(c)}
                                  onCheckedChange={(checked) => {
                                    if (checked) {
                                      setFormTribTiposExcluidos((prev) => [...prev, c]);
                                    } else {
                                      setFormTribTiposExcluidos((prev) => prev.filter((t) => t !== c));
                                    }
                                  }}
                                />
                                <span className="text-sm">{c}</span>
                              </label>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Ex.: FII (padrão regulatório). Esses tipos nunca entram no numerador de LP.
                          </p>
                        </div>
                        <label className="flex items-start gap-2 cursor-pointer rounded-md border p-3">
                          <Checkbox
                            checked={formTribDenominadorElegivel}
                            onCheckedChange={(c) => setFormTribDenominadorElegivel(c === true)}
                          />
                          <span className="text-sm leading-snug">
                            No % LP do dia, usar PL <strong>sem</strong> os tipos excluídos acima
                          </span>
                        </label>
                        <p className="text-[10px] text-muted-foreground">
                          Marcado: % LP = LP ÷ (soma das cotas que não estão excluídas). Desmarcado: % LP = LP ÷ PL total do fundo.
                        </p>
                      </>
                    )}
                    {formTipo === "percentual_pl_por_categoria" && (
                      <>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Segmento</Label>
                          <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <Checkbox
                                checked={formSegmentos.includes("COTAS")}
                                onCheckedChange={(checked) => {
                                  if (checked) setFormSegmentos((prev) => [...prev.filter((s) => s !== "COTAS"), "COTAS"]);
                                  else setFormSegmentos((prev) => prev.filter((s) => s !== "COTAS"));
                                }}
                              />
                              <span className="text-sm">COTAS (fundos investidos)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <Checkbox
                                checked={formSegmentos.includes("ATIVOS_FINANCEIROS")}
                                onCheckedChange={(checked) => {
                                  if (checked) setFormSegmentos((prev) => [...prev.filter((s) => s !== "ATIVOS_FINANCEIROS"), "ATIVOS_FINANCEIROS"]);
                                  else setFormSegmentos((prev) => prev.filter((s) => s !== "ATIVOS_FINANCEIROS"));
                                }}
                              />
                              <span className="text-sm">ATIVOS FINANCEIROS (ativos diretos)</span>
                            </label>
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Selecione um ou ambos. A regra considerará a soma dos valores.
                          </p>
                        </div>
                        {formSegmentos.includes("COTAS") && (
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Tipo de Cota</Label>
                            <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                              {cotasTipos.map((c) => (
                                <label key={c} className="flex items-center gap-2 cursor-pointer">
                                  <Checkbox
                                    checked={formCotasTipos.includes(c)}
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        if (c === "Todas") setFormCotasTipos(["Todas"]);
                                        else setFormCotasTipos((prev) => [...prev.filter((t) => t !== "Todas"), c]);
                                      } else {
                                        setFormCotasTipos((prev) => prev.filter((t) => t !== c));
                                        if (formCotasTipos.length <= 1) setFormCotasTipos(["Todas"]);
                                      }
                                    }}
                                  />
                                  <span className="text-sm">{c}</span>
                                </label>
                              ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              Todas = todas as cotas. Selecione um ou mais tipos (FIDC, FII, FIA, FIP, etc.).
                            </p>
                          </div>
                        )}
                        {formSegmentos.includes("ATIVOS_FINANCEIROS") && (
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Section da Carteira</Label>
                            <div className="border rounded-md p-3 space-y-2">
                              {ATIVOS_FINANCEIROS_SECTIONS.map((s) => (
                                <div key={s.value}>
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <Checkbox
                                      checked={formSectionCarteiras.includes(s.value)}
                                      onCheckedChange={(checked) => {
                                        if (checked) {
                                          setFormSectionCarteiras((prev) => [...prev, s.value]);
                                        } else {
                                          setFormSectionCarteiras((prev) => prev.filter((v) => v !== s.value));
                                          if (s.value === "outros") setFormOutrosProvisaoCodprov([]);
                                        }
                                      }}
                                    />
                                    <span className="text-sm">{s.label}</span>
                                  </label>

                                  {/* Sub-painel de filtro por código de provisão — visível apenas quando "Outros" está marcado */}
                                  {s.value === "outros" && formSectionCarteiras.includes("outros") && (
                                    <div className="ml-6 mt-2 border border-amber-200/60 rounded-md bg-amber-50/40 p-3 space-y-3">
                                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
                                        Filtrar Provisões por Código (codprov)
                                      </p>
                                      <p className="text-[10px] text-muted-foreground">
                                        Sem seleção: inclui <em>todos</em> os registros fora das sections principais.
                                        Selecionando códigos: inclui apenas provisões com esses códigos e crédito (C).
                                      </p>

                                      {/* Códigos conhecidos */}
                                      <div className="space-y-1.5">
                                        {PROVISAO_CODPROV_CONHECIDOS.map((c) => (
                                          <label key={c.value} className="flex items-center gap-2 cursor-pointer">
                                            <Checkbox
                                              checked={formOutrosProvisaoCodprov.includes(c.value)}
                                              onCheckedChange={(checked) => {
                                                if (checked) setFormOutrosProvisaoCodprov((prev) => [...prev, c.value]);
                                                else setFormOutrosProvisaoCodprov((prev) => prev.filter((v) => v !== c.value));
                                              }}
                                            />
                                            <span className="text-xs font-mono">{c.label}</span>
                                          </label>
                                        ))}
                                      </div>

                                      {/* Códigos já selecionados não presentes na lista conhecida (custom) */}
                                      {formOutrosProvisaoCodprov
                                        .filter((v) => !PROVISAO_CODPROV_CONHECIDOS.some((c) => c.value === v))
                                        .map((v) => (
                                          <label key={v} className="flex items-center gap-2 cursor-pointer">
                                            <Checkbox
                                              checked
                                              onCheckedChange={() =>
                                                setFormOutrosProvisaoCodprov((prev) => prev.filter((x) => x !== v))
                                              }
                                            />
                                            <span className="text-xs font-mono">{v} — código personalizado</span>
                                          </label>
                                        ))}

                                      {/* Adicionar código personalizado */}
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="text"
                                          className="h-7 w-24 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                                          placeholder="Ex: 15"
                                          value={formOutrosProvisaoCustomCod}
                                          onChange={(e) => setFormOutrosProvisaoCustomCod(e.target.value.trim())}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" && formOutrosProvisaoCustomCod) {
                                              const cod = formOutrosProvisaoCustomCod;
                                              if (!formOutrosProvisaoCodprov.includes(cod)) {
                                                setFormOutrosProvisaoCodprov((prev) => [...prev, cod]);
                                              }
                                              setFormOutrosProvisaoCustomCod("");
                                            }
                                          }}
                                        />
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-[11px]"
                                          disabled={!formOutrosProvisaoCustomCod}
                                          onClick={() => {
                                            const cod = formOutrosProvisaoCustomCod;
                                            if (cod && !formOutrosProvisaoCodprov.includes(cod)) {
                                              setFormOutrosProvisaoCodprov((prev) => [...prev, cod]);
                                            }
                                            setFormOutrosProvisaoCustomCod("");
                                          }}
                                        >
                                          + Adicionar
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              Selecione uma ou mais sections (Título Público, Privado, Participações, etc.).
                            </p>
                          </div>
                        )}
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite mínimo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Ex: 10"
                            value={formLimiteMinPct === "" ? "" : formLimiteMinPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMinPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite máximo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Ex: 40"
                            value={formLimiteMaxPct === "" ? "" : formLimiteMaxPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMaxPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Preencha pelo menos um dos limites (mínimo ou máximo).
                        </p>
                      </>
                    )}
                    {formTipo === "vedacao" && (
                      <>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Tipo de fundo (que tem a restrição) — opcional</Label>
                          <Select
                            value={formTipoFundo || "__nenhum__"}
                            onValueChange={(v) => setFormTipoFundo(v === "__nenhum__" ? "" : v)}
                            disabled={isLoadingCategorias || categoriasFundo.length === 0}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Nenhum — use fundos específicos" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__nenhum__">— Nenhum</SelectItem>
                              {categoriasFundo.filter((c) => c !== "Cotas").map((c) => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Use quando a vedação se aplicar apenas a tipos específicos de fundos.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Fundos específicos — opcional</Label>
                          <Input
                            placeholder="Buscar fundo por nome ou CNPJ..."
                            value={buscaFundos}
                            onChange={(e) => setBuscaFundos(e.target.value)}
                            className="h-8 text-xs"
                          />
                          <div className="border rounded-md p-3 max-h-32 overflow-y-auto space-y-2">
                            {isLoadingFundos ? (
                              <p className="text-xs text-muted-foreground">Carregando fundos...</p>
                            ) : fundosLista.length === 0 ? (
                              <p className="text-xs text-muted-foreground">Nenhum fundo na base.</p>
                            ) : (
                              fundosLista
                                .filter((f) => !buscaFundos.trim() || f.nome.toLowerCase().includes(buscaFundos.toLowerCase()) || f.cnpj.includes(buscaFundos.replace(/\D/g, "")))
                                .slice(0, 200)
                                .map((f) => (
                                <label key={f.cnpj} className="flex items-center gap-2 cursor-pointer">
                                  <Checkbox
                                    checked={formFundosCnpj.includes(f.cnpj)}
                                    onCheckedChange={(checked) => {
                                      if (checked) setFormFundosCnpj((prev) => [...prev, f.cnpj]);
                                      else setFormFundosCnpj((prev) => prev.filter((c) => c !== f.cnpj));
                                    }}
                                  />
                                  <span className="text-xs truncate" title={f.nome}>{f.nome}</span>
                                </label>
                              ))
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Selecione fundos específicos para regra direcionada. Se nenhum tipo ou fundo for selecionado, a regra não será aplicada.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Categoria vedada</Label>
                          <div className="border rounded-md p-3 max-h-32 overflow-y-auto space-y-2">
                            {categoriasFundo.filter((c) => c !== "Cotas").map((c) => (
                              <label key={c} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={formCategoriasVedadas.includes(c)}
                                  onCheckedChange={(checked) => {
                                    if (checked) setFormCategoriasVedadas((prev) => [...prev, c]);
                                    else setFormCategoriasVedadas((prev) => prev.filter((t) => t !== c));
                                  }}
                                />
                                <span className="text-sm">{c}</span>
                              </label>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Ex.: FIDC não pode ter cotas de Multimercados. Selecione uma ou mais categorias.
                          </p>
                        </div>
                      </>
                    )}
                    {formTipo === "limite_por_tipo_investidor" && (
                      <>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Tipo de Investidor do Fundo Investido</Label>
                          <Select value={formTipoInvestidor} onValueChange={setFormTipoInvestidor}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TIPOS_INVESTIDOR.map((t) => (
                                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Filtra fundos pela característica de investidor (fundos_caracteristicas).
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Categoria do Fundo Investido (opcional)</Label>
                          <Select value={formNivel1Investidor || "__nenhum__"} onValueChange={(v) => setFormNivel1Investidor(v === "__nenhum__" ? "" : v)}>
                            <SelectTrigger>
                              <SelectValue placeholder="Nenhum filtro adicional" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__nenhum__">— Nenhum</SelectItem>
                              {categoriasFundo.filter((c) => c !== "Cotas").map((c) => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Ex.: FIDC NP para limite em Fundos Alvo com créditos não-padronizados.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Administrador do Fundo Investido (opcional)</Label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <Checkbox
                              checked={formMesmaAdministradora}
                              onCheckedChange={(checked) => setFormMesmaAdministradora(!!checked)}
                            />
                            <span className="text-sm">Mesma administradora do fundo investidor</span>
                          </label>
                          <p className="text-[10px] text-muted-foreground">
                            Quando marcado, aplica o limite apenas para fundos alvo administrados pela mesma administradora (baseado em <code>fundo_cnpjadm</code> de posicao_carteira).
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite mínimo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Opcional"
                            value={formLimiteMinPct === "" ? "" : formLimiteMinPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMinPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite máximo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Ex: 10"
                            value={formLimiteMaxPct === "" ? "" : formLimiteMaxPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMaxPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                        </div>
                      </>
                    )}
                    {(formTipo === "CONCENTRACAO_DEVEDOR" ||
                      formTipo === "CONCENTRACAO_CEDENTE" ||
                      formTipo === "CONCENTRACAO_SEM_COOBRIGACAO") && (
                      <>
                        <div className="rounded-md border border-blue-200 bg-blue-50/60 dark:bg-blue-950/20 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-700 dark:text-blue-300 space-y-0.5">
                          <p className="font-semibold">Regra de concentração granular de FIDC</p>
                          <p>O cálculo usa a tabela <code>estoque_fidc</code> (importada via CSV Frontis). O fundo deve ter ao menos uma importação de estoque válida associada ao CNPJ para que a regra seja avaliada.</p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Base de Cálculo da Exposição</Label>
                          <Select
                            value={formBaseCalculo}
                            onValueChange={setFormBaseCalculo}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="valor_presente">Valor Presente (padrão)</SelectItem>
                              <SelectItem value="valor_nominal">Valor Nominal</SelectItem>
                              <SelectItem value="valor_aquisicao">Valor de Aquisição</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Campo do <code>estoque_fidc</code> usado como numerador da exposição.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Abater PDD da Exposição? <span className="text-red-500">*</span></Label>
                          <Select
                            value={formUsarAbatimentoPdd ? "sim" : "nao"}
                            onValueChange={(v) => setFormUsarAbatimentoPdd(v === "sim")}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="nao">Não — usar valor bruto</SelectItem>
                              <SelectItem value="sim">Sim — subtrair PDD (exposição líquida = max(base − PDD, 0))</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Quando "Sim", a exposição de cada recebível será <code>max(base_calculo − valor_pdd, 0)</code>.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Origem do PL <span className="text-red-500">*</span></Label>
                          <Select
                            value={formOrigemPl}
                            onValueChange={setFormOrigemPl}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pl_mes_anterior_posicao">
                                PL mês anterior (posição diária — recomendado)
                              </SelectItem>
                              <SelectItem value="pl_atual_xml">PL do dia (posição atual)</SelectItem>
                              <SelectItem value="pl_mes_anterior_informe_mensal">
                                PL mês anterior (Informe Mensal CVM — legado)
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Padrão: última <code>posicao_carteira</code> importada no mês anterior
                            (ex.: posição 05/06 usa PL de 30/05 ou último dia disponível em maio).
                            Aplica <code>pl_formula</code> da subclasse (ex.: <code>va_vr</code> no Nexum JR).
                            Se não houver posição no mês anterior, usa PL do dia com alerta de fallback.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite mínimo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Ex: 0"
                            value={formLimiteMinPct === "" ? "" : formLimiteMinPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMinPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite máximo (% do PL)</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="Ex: 5"
                            value={formLimiteMaxPct === "" ? "" : formLimiteMaxPct}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFormLimiteMaxPct(v === "" ? "" : Number(v) || 0);
                            }}
                          />
                          <p className="text-[10px] text-muted-foreground">
                            {formTipo === "CONCENTRACAO_DEVEDOR" && "Percentual máximo que um único Devedor (Sacado) pode representar do PL da Classe."}
                            {formTipo === "CONCENTRACAO_CEDENTE" && "Percentual máximo que um único Cedente/Emissor pode representar do PL da Classe."}
                            {formTipo === "CONCENTRACAO_SEM_COOBRIGACAO" && "Percentual máximo da soma total dos recebíveis sem coobrigação sobre o PL da Classe."}
                          </p>
                        </div>
                        {formTipo === "CONCENTRACAO_DEVEDOR" && (
                          <>
                            <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase">Fundo para exceções por sacado (opcional)</Label>
                              <Select
                                value={formExcecaoFundoCnpj || "__nenhum__"}
                                onValueChange={(v) => {
                                  const next = v === "__nenhum__" ? "" : v;
                                  setFormExcecaoFundoCnpj(next);
                                  setFormExcecoesSacado([]);
                                  setBuscaSacados("");
                                }}
                                disabled={isLoadingFundos}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Sem exceções por sacado" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__nenhum__">— Sem exceções</SelectItem>
                                  {fundosLista.map((f) => (
                                    <SelectItem key={f.cnpj} value={f.cnpj}>
                                      {f.nome}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-[10px] text-muted-foreground">
                                As exceções são salvas por fundo dentro da própria regra. Se selecionar um fundo, os sacados virão do último estoque FIDC disponível dele.
                              </p>
                            </div>
                            {formExcecaoFundoCnpj && (
                              <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase">Sacados com exceção (opcional)</Label>
                                <Input
                                  placeholder="Buscar sacado por nome ou CNPJ..."
                                  value={buscaSacados}
                                  onChange={(e) => setBuscaSacados(e.target.value)}
                                  className="h-8 text-xs"
                                />
                                <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                                  {isLoadingSacados ? (
                                    <p className="text-xs text-muted-foreground">Carregando sacados do último estoque...</p>
                                  ) : sacadosDisponiveis.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">Nenhum sacado encontrado no último estoque do fundo selecionado.</p>
                                  ) : (
                                    sacadosDisponiveis
                                      .filter((s) =>
                                        !buscaSacados.trim() ||
                                        s.nome.toLowerCase().includes(buscaSacados.toLowerCase()) ||
                                        (s.documento || "").includes(buscaSacados.replace(/\D/g, ""))
                                      )
                                      .slice(0, 100)
                                      .map((s) => {
                                        const jaSelecionado = formExcecoesSacado.some((item) => item.chave === s.chave);
                                        return (
                                          <div key={s.chave} className="flex items-center justify-between gap-2 border rounded px-2 py-1.5">
                                            <div className="min-w-0">
                                              <div className="text-xs font-medium truncate">{s.nome}</div>
                                              <div className="text-[10px] text-muted-foreground font-mono">
                                                {s.documento || "Sem CNPJ"} · {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(s.exposicao)}
                                              </div>
                                            </div>
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="sm"
                                              disabled={jaSelecionado}
                                              onClick={() =>
                                                setFormExcecoesSacado((prev) => [
                                                  ...prev,
                                                  {
                                                    chave: s.chave,
                                                    nome: s.nome,
                                                    documento: s.documento,
                                                    modo: "ignorar",
                                                    limiteMaxPct: "",
                                                  },
                                                ])
                                              }
                                            >
                                              {jaSelecionado ? "Adicionado" : "Adicionar"}
                                            </Button>
                                          </div>
                                        );
                                      })
                                  )}
                                </div>
                                {formExcecoesSacado.length > 0 && (
                                  <div className="border rounded-md p-3 space-y-3">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                      Exceções configuradas
                                    </div>
                                    {formExcecoesSacado.map((item) => (
                                      <div key={item.chave} className="grid grid-cols-1 gap-2 border rounded p-2">
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="min-w-0">
                                            <div className="text-sm font-medium truncate">{item.nome}</div>
                                            <div className="text-[10px] text-muted-foreground font-mono">{item.documento || "Sem CNPJ"}</div>
                                          </div>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setFormExcecoesSacado((prev) => prev.filter((x) => x.chave !== item.chave))}
                                          >
                                            Remover
                                          </Button>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                          <Select
                                            value={item.modo}
                                            onValueChange={(v) =>
                                              setFormExcecoesSacado((prev) =>
                                                prev.map((x) =>
                                                  x.chave === item.chave
                                                    ? { ...x, modo: v as ModoExcecaoSacado, limiteMaxPct: v === "ignorar" ? "" : x.limiteMaxPct }
                                                    : x
                                                )
                                              )
                                            }
                                          >
                                            <SelectTrigger>
                                              <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value="ignorar">Não aplicar a regra para este sacado</SelectItem>
                                              <SelectItem value="limite_customizado">Aplicar limite específico</SelectItem>
                                            </SelectContent>
                                          </Select>
                                          {item.modo === "limite_customizado" && (
                                            <Input
                                              type="number"
                                              min={0}
                                              max={100}
                                              placeholder="Limite %"
                                              value={item.limiteMaxPct === "" ? "" : item.limiteMaxPct}
                                              onChange={(e) => {
                                                const v = e.target.value;
                                                setFormExcecoesSacado((prev) =>
                                                  prev.map((x) =>
                                                    x.chave === item.chave
                                                      ? { ...x, limiteMaxPct: v === "" ? "" : Number(v) || 0 }
                                                      : x
                                                  )
                                                );
                                              }}
                                            />
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                    {formTipo === "CESSAO_CONDICAO" && (
                      <>
                        <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300 space-y-0.5">
                          <p className="font-semibold">Condição de Cessão / Elegibilidade</p>
                          <p>Regra genérica e configurável. Cada parâmetro pode ser diferente por fundo via <em>Regras Relacionais</em>.</p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Campo / Critério</Label>
                          <Select value={formCessaoCampo} onValueChange={(v) => {
                            setFormCessaoCampo(v);
                            if (v === "vencimento") { setFormCessaoUnidade("dias"); setFormCessaoOperador("<="); }
                            if (v === "prazo") { setFormCessaoUnidade("dias"); setFormCessaoOperador("<="); }
                            if (v === "taxa_cessao_implicita") { setFormCessaoUnidade("percentual_cdi"); setFormCessaoOperador(">="); setFormCessaoValorLimite(140); }
                            if (v === "taxa_cessao") { setFormCessaoUnidade("percentual_cdi"); setFormCessaoOperador(">="); }
                            if (v === "inadimplencia_cedente") { setFormCessaoUnidade("dias"); setFormCessaoOperador("<="); }
                            if (v === "prazo_medio") { setFormCessaoUnidade("dias"); setFormCessaoOperador("<="); setFormCessaoModo("proforma"); }
                            if (v === "exposicao_prazo_acima") { setFormCessaoUnidade("percentual_pl"); setFormCessaoOperador("<="); setFormCessaoModo("proforma"); }
                            if (v === "concentracao_devedor" || v === "concentracao_cedente" || v === "sem_coobrigacao") { setFormCessaoUnidade("percentual_pl"); setFormCessaoOperador("<="); setFormCessaoModo("concentracao"); }
                            if (v === "tipo_recebivel") { setFormCessaoModo("individual"); }
                            if (v === "substituicao_unica") { setFormCessaoModo("individual"); }
                          }}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CESSAO_CAMPOS.map(c => (
                                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Modo de Avaliação</Label>
                          <Select value={formCessaoModo} onValueChange={setFormCessaoModo}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CESSAO_MODOS.map(m => (
                                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            Individual: avalia cada DC isoladamente. Pró-forma: avalia a carteira simulada. Concentração: estoque + cessão.
                          </p>
                        </div>
                        {formCessaoCampo !== "vencimento" && formCessaoCampo !== "tipo_recebivel" && formCessaoCampo !== "substituicao_unica" && (
                          <>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase">Operador</Label>
                                <Select value={formCessaoOperador} onValueChange={setFormCessaoOperador}>
                                  <SelectTrigger><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {CESSAO_OPERADORES.map(o => (
                                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase">Unidade</Label>
                                <Select value={formCessaoUnidade} onValueChange={setFormCessaoUnidade}>
                                  <SelectTrigger><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {CESSAO_UNIDADES.map(u => (
                                      <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase">Valor Limite</Label>
                              <Input
                                type="number"
                                step="any"
                                placeholder="Ex: 365, 140, 5, 2"
                                value={formCessaoValorLimite === "" ? "" : formCessaoValorLimite}
                                onChange={(e) => setFormCessaoValorLimite(e.target.value === "" ? "" : Number(e.target.value))}
                              />
                              {formCessaoUnidade === "percentual_cdi" && typeof formCessaoCdiVigente === "number" && typeof formCessaoValorLimite === "number" && (
                                <p className="text-[10px] text-muted-foreground">
                                  Taxa calculada: <strong>{(formCessaoCdiVigente * formCessaoValorLimite / 100).toFixed(2)}% a.a.</strong> ({formCessaoValorLimite}% × CDI {formCessaoCdiVigente}%)
                                </p>
                              )}
                            </div>
                          </>
                        )}
                        {formCessaoCampo === "exposicao_prazo_acima" && (
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Referência de prazo (dias úteis)</Label>
                            <Input
                              type="number"
                              step="1"
                              min={1}
                              placeholder="Ex: 90"
                              value={formCessaoDiasReferencia === "" ? "" : formCessaoDiasReferencia}
                              onChange={(e) => setFormCessaoDiasReferencia(e.target.value === "" ? "" : Number(e.target.value))}
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Títulos com prazo <strong>acima</strong> deste valor serão somados para compor a exposição verificada.
                            </p>
                          </div>
                        )}
                        {formCessaoUnidade === "percentual_cdi" && (
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">CDI vigente (% a.a.) <span className="text-red-500">*</span></Label>
                            <Input
                              type="number"
                              step="0.01"
                              min={0}
                              placeholder="Ex: 14.75"
                              value={formCessaoCdiVigente === "" ? "" : formCessaoCdiVigente}
                              onChange={(e) => setFormCessaoCdiVigente(e.target.value === "" ? "" : Number(e.target.value) || 0)}
                            />
                            {formCessaoCampo === "taxa_cessao_implicita" && typeof formCessaoCdiVigente === "number" && typeof formCessaoValorLimite === "number" && formCessaoCdiVigente > 0 && (
                              <div className="rounded-md border border-blue-200 bg-blue-50/60 dark:bg-blue-950/20 dark:border-blue-800 px-3 py-2 text-[10px] text-blue-700 dark:text-blue-300 space-y-0.5">
                                <p className="font-semibold">Fórmula (juros compostos base 252 du)</p>
                                {(() => {
                                  const cdiAa = formCessaoCdiVigente / 100;
                                  const cdiDu = Math.pow(1 + cdiAa, 1 / 252) - 1;
                                  const taxaMinDu = (formCessaoValorLimite / 100) * cdiDu;
                                  const taxaMinAa = (Math.pow(1 + taxaMinDu, 252) - 1) * 100;
                                  return (
                                    <>
                                      <p>CDI diário: <strong>{(cdiDu * 100).toFixed(4)}%</strong> → Taxa mín. diária: <strong>{(taxaMinDu * 100).toFixed(4)}%</strong></p>
                                      <p>Taxa mín. anual equivalente: <strong>{taxaMinAa.toFixed(2)}% a.a.</strong> ({formCessaoValorLimite}% × CDI {formCessaoCdiVigente}%)</p>
                                      <p className="text-[9px] opacity-75">ELEGIVEL = TOTAL_NOMINAL ≥ TOTAL_AQUISICAO × (1 + {(taxaMinDu * 100).toFixed(4)}%)^PRAZO</p>
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                            {formCessaoCampo !== "taxa_cessao_implicita" && typeof formCessaoCdiVigente === "number" && typeof formCessaoValorLimite === "number" && (
                              <p className="text-[10px] text-muted-foreground">
                                Taxa mínima: <strong>{(formCessaoCdiVigente * (formCessaoValorLimite / 100)).toFixed(2)}% a.a.</strong> ({formCessaoValorLimite}% × CDI {formCessaoCdiVigente}%)
                              </p>
                            )}
                            <p className="text-[10px] text-muted-foreground">
                              Atualizar manualmente com a taxa DI do dia da cessão.
                            </p>
                          </div>
                        )}
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Filtrar por tipo de recebível (opcional)</Label>
                          <div className="border rounded-md p-3 max-h-32 overflow-y-auto space-y-2">
                            {TIPOS_RECEBIVEL.map(t => (
                              <label key={t} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={formCessaoFiltroTipoRecebivel.includes(t)}
                                  onCheckedChange={(checked) => {
                                    if (checked) setFormCessaoFiltroTipoRecebivel(prev => [...prev, t]);
                                    else setFormCessaoFiltroTipoRecebivel(prev => prev.filter(x => x !== t));
                                  }}
                                />
                                <span className="text-sm">{t}</span>
                              </label>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Se nenhum for selecionado, a regra se aplica a todos os tipos. Se selecionar um ou mais, a regra só vale para esses tipos.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Descrição livre (opcional)</Label>
                          <Input
                            placeholder="Ex: Prazo máximo de 365 dias para Duplicatas"
                            value={formCessaoDescricaoLivre}
                            onChange={(e) => setFormCessaoDescricaoLivre(e.target.value)}
                          />
                          <p className="text-[10px] text-muted-foreground">
                            Se preenchida, substitui a descrição gerada automaticamente. Use para descrever a regra conforme o regulamento.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Referência no regulamento (opcional)</Label>
                          <Input
                            placeholder="Ex: item 5.17, cláusula iv"
                            value={formCessaoRefRegulamento}
                            onChange={(e) => setFormCessaoRefRegulamento(e.target.value)}
                          />
                        </div>
                      </>
                    )}
                    {formTipo === "CESSAO_CADASTRO_PARTES" && (
                      <>
                        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 dark:bg-emerald-950/20 dark:border-emerald-800 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-300 space-y-1">
                          <p className="font-semibold">Cadastro de Partes — regra ativadora</p>
                          <p>A lista de cedentes/sacados e limites fica em <strong>/credito/cadastro-partes</strong> (importação da planilha da consultoria). Esta regra apenas liga a verificação na simulação de cessão.</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={formCadVerificarCedente} onCheckedChange={(c) => setFormCadVerificarCedente(!!c)} />
                            Verificar cedente
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={formCadVerificarSacado} onCheckedChange={(c) => setFormCadVerificarSacado(!!c)} />
                            Verificar sacado
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Não cadastrado</Label>
                            <Select value={formCadPoliticaNaoCadastrado} onValueChange={(v) => setFormCadPoliticaNaoCadastrado(v as PoliticaCadastro)}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="vedar">Vedar</SelectItem>
                                <SelectItem value="alertar">Alertar</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Cadastro vencido</Label>
                            <Select value={formCadPoliticaVencido} onValueChange={(v) => setFormCadPoliticaVencido(v as PoliticaCadastro)}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="vedar">Vedar</SelectItem>
                                <SelectItem value="alertar">Alertar</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Revisão pendente</Label>
                            <Select value={formCadPoliticaPendente} onValueChange={(v) => setFormCadPoliticaPendente(v as PoliticaCadastro)}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="alertar">Alertar (padrão)</SelectItem>
                                <SelectItem value="vedar">Vedar</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2 flex items-end">
                            <label className="flex items-center gap-2 text-sm pb-2">
                              <Checkbox checked={formCadValidadeInclusiva} onCheckedChange={(c) => setFormCadValidadeInclusiva(!!c)} />
                              Validade inclusiva (cessão no dia do vencimento passa)
                            </label>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase">Base de cálculo (limite R$)</Label>
                            <Select value={formBaseCalculo} onValueChange={setFormBaseCalculo}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="valor_presente">Valor Presente / Nominal</SelectItem>
                                <SelectItem value="valor_nominal">Valor Nominal</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2 flex items-end">
                            <label className="flex items-center gap-2 text-sm pb-2">
                              <Checkbox checked={formUsarAbatimentoPdd} onCheckedChange={(c) => setFormUsarAbatimentoPdd(!!c)} />
                              Abater PDD na exposição
                            </label>
                          </div>
                        </div>
                      </>
                    )}
                    {formTipo === "agrupamento_conjunto" && (
                      <>
                        <div className="rounded-md border border-blue-200 bg-blue-50/60 dark:bg-blue-950/20 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-700 dark:text-blue-300 space-y-0.5">
                          <p className="font-semibold">Agrupamento Conjunto (soma de múltiplas exposições)</p>
                          <p>Soma automaticamente diferentes tipos de exposições (categorias, tipos de investidor, etc.) e aplica um limite único ao total.</p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Limite Máximo (% do PL)</Label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={formLimiteMaxPct}
                              onChange={(e) => setFormLimiteMaxPct(e.target.value === "" ? "" : Number(e.target.value))}
                              className="w-24"
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Modo de Configuração</Label>
                          <Select value={formModoAgrupamento} onValueChange={(v: ModoAgrupamento) => setFormModoAgrupamento(v)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="por_regras">Selecionar Regras Existentes (Recomendado)</SelectItem>
                              <SelectItem value="por_componentes">Criar Componentes Manualmente</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            {formModoAgrupamento === "por_regras" 
                              ? "Selecione regras já cadastradas para somar suas exposições"
                              : "Configure manualmente cada componente que será somado"}
                          </p>
                        </div>

                        {formModoAgrupamento === "por_regras" ? (
                          <div className="space-y-3">
                            <Label className="text-xs font-bold uppercase">
                              Regras Base ({formRegrasBaseSelecionadas.length} selecionadas)
                            </Label>
                            <div className="space-y-2">
                              <div className="relative">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                  placeholder="Buscar regras..."
                                  value={buscaRegras}
                                  onChange={(e) => setBuscaRegras(e.target.value)}
                                  className="pl-8"
                                />
                              </div>
                              <div className="border rounded-md p-3 max-h-[300px] overflow-y-auto space-y-2">
                                {regras
                                  .filter(r => {
                                    if (r.id === editingId) return false;
                                    const p = r.parametros as Record<string, unknown>;
                                    if (p?.tipo_regra === "agrupamento_conjunto") return false;
                                    if (buscaRegras) {
                                      const busca = buscaRegras.toLowerCase();
                                      return r.codigo.toLowerCase().includes(busca) || 
                                             r.descricao.toLowerCase().includes(busca);
                                    }
                                    return true;
                                  })
                                  .map(r => (
                                    <label key={r.id} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-muted/50 transition-colors">
                                      <Checkbox
                                        checked={formRegrasBaseSelecionadas.includes(r.codigo)}
                                        onCheckedChange={(checked) => {
                                          if (checked) {
                                            setFormRegrasBaseSelecionadas(prev => [...prev, r.codigo]);
                                          } else {
                                            setFormRegrasBaseSelecionadas(prev => prev.filter(c => c !== r.codigo));
                                          }
                                        }}
                                        className="mt-0.5"
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="font-mono text-xs font-semibold">{r.codigo}</div>
                                        <div className="text-[11px] text-muted-foreground line-clamp-2">{r.descricao}</div>
                                      </div>
                                    </label>
                                  ))}
                                {regras.filter(r => {
                                  if (r.id === editingId) return false;
                                  const p = r.parametros as Record<string, unknown>;
                                  if (p?.tipo_regra === "agrupamento_conjunto") return false;
                                  if (buscaRegras) {
                                    const busca = buscaRegras.toLowerCase();
                                    return r.codigo.toLowerCase().includes(busca) || 
                                           r.descricao.toLowerCase().includes(busca);
                                  }
                                  return true;
                                }).length === 0 && (
                                  <div className="text-center py-4 text-sm text-muted-foreground">
                                    {buscaRegras ? "Nenhuma regra encontrada" : "Nenhuma regra disponível"}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <Label className="text-xs font-bold uppercase">Componentes do Grupo ({formComponentes.length})</Label>
                            <p className="text-[10px] text-muted-foreground">
                              Adicione os componentes que serão somados. Ativos duplicados são contabilizados apenas uma vez.
                            </p>
                            {formComponentes.length === 0 && (
                              <div className="border border-dashed rounded-md p-4 text-center text-sm text-muted-foreground">
                                Nenhum componente adicionado. Clique em "+ Adicionar Componente" para começar.
                              </div>
                            )}
                            {formComponentes.map((comp, idx) => (
                            <div key={comp.id} className="border rounded-md p-3 space-y-2 bg-muted/30">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold">Componente {idx + 1}</span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={() => setFormComponentes(prev => prev.filter(c => c.id !== comp.id))}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                              <div className="grid gap-2">
                                <div className="space-y-1">
                                  <Label className="text-[10px] uppercase">Segmento / Tipo</Label>
                                  <Select
                                    value={comp.tipo}
                                    onValueChange={(v: any) => {
                                      setFormComponentes(prev => prev.map(c =>
                                        c.id === comp.id ? { ...c, tipo: v, valor: "" } : c
                                      ));
                                    }}
                                  >
                                    <SelectTrigger className="h-9">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="tipo_investidor">Tipo Investidor</SelectItem>
                                      <SelectItem value="cotas">COTAS (fundos investidos)</SelectItem>
                                      <SelectItem value="ativos_financeiros">ATIVOS FINANCEIROS (ativos diretos)</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-[10px] uppercase">
                                    {comp.tipo === "tipo_investidor" ? "Tipo de Investidor" :
                                     comp.tipo === "cotas" ? "Categoria" :
                                     comp.tipo === "ativos_financeiros" ? "Seção de Carteira" : "Valor"}
                                  </Label>
                                  {comp.tipo === "tipo_investidor" && (
                                    <Select
                                      value={comp.valor}
                                      onValueChange={(v) => {
                                        setFormComponentes(prev => prev.map(c =>
                                          c.id === comp.id ? { ...c, valor: v } : c
                                        ));
                                      }}
                                    >
                                      <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Selecione..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {TIPOS_INVESTIDOR.map(t => (
                                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                  {comp.tipo === "cotas" && (
                                    <Select
                                      value={comp.valor}
                                      onValueChange={(v) => {
                                        setFormComponentes(prev => prev.map(c =>
                                          c.id === comp.id ? { ...c, valor: v } : c
                                        ));
                                      }}
                                    >
                                      <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Selecione categoria..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {categoriasFundo.map(cat => (
                                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                  {comp.tipo === "ativos_financeiros" && (
                                    <Select
                                      value={comp.valor}
                                      onValueChange={(v) => {
                                        setFormComponentes(prev => prev.map(c =>
                                          c.id === comp.id ? { ...c, valor: v } : c
                                        ));
                                      }}
                                    >
                                      <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Selecione seção..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {ATIVOS_FINANCEIROS_SECTIONS.map(s => (
                                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => {
                              const newId = `comp-${Date.now()}`;
                              setFormComponentes(prev => [...prev, {
                                id: newId,
                                tipo: "cotas",
                                valor: "",
                                peso: 1.0
                              }]);
                            }}
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Adicionar Componente
                          </Button>
                        </div>
                        )}
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase">Método de Agregação</Label>
                          <Select value={formMetodoAgregacao} onValueChange={setFormMetodoAgregacao}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="soma">Soma (padrão para limites regulatórios)</SelectItem>
                              <SelectItem value="maximo">Máximo (maior exposição individual)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </>
                    )}
                  </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>
                      Cancelar
                    </Button>
                    <Button
                      onClick={handleSubmit}
                      disabled={createMutation.isPending || updateMutation.isPending}
                    >
                      {(createMutation.isPending || updateMutation.isPending) && (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      )}
                      {editingId ? "Salvar" : "Criar Regra"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : regrasFiltradas.length === 0 ? (
              <div className="text-center py-12 border border-dashed rounded-lg">
                <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-20" />
                <p className="text-sm text-muted-foreground">
                  {regras.length === 0 ? "Nenhuma regra cadastrada. Clique em Nova Regra para criar." : "Nenhuma regra encontrada com o filtro aplicado."}
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-[10px] font-bold uppercase">Código</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase">Descrição</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase w-[100px] text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {regrasFiltradas.map((r) => (
                      <TableRow key={r.id} className="hover:bg-muted/30">
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {r.codigo}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{r.descricao}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(r)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Remover regra?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    A regra <strong>{r.codigo}</strong> será excluída. Associações em fundos também serão afetadas.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => deleteMutation.mutate(r)}
                                    disabled={deleteMutation.isPending}
                                  >
                                    Remover
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
