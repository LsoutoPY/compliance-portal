import { Fragment, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/design-system/components/core/Button";
import { Card } from "@/design-system/components/core/Card";
import { Badge } from "@/design-system/components/core/Badge";
import { Input } from "@/design-system/components/forms/Input";
import { Select } from "@/design-system/components/forms/Select";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Asset {
  id: string | number;
  cnpjfundo?: string;
  cnpjemissor?: string;
  isin?: string;
  codativo?: string;
  codprov?: string | null;
  nome_comercial_ativo?: string;
  section: string;
  qtdisponivel: number;
  puposicao: number;
  valor_padrao: number;
  prazo_pagamento_resgate_dias?: number | null;
  prazos_em_dias?: number | null;
  vertice?: number;
  credeb?: string;
  validado?: boolean;
  isSectionAggregate?: boolean;
  /** Descrição ANBIMA do lançamento (de-para codprov → anbima_cod_lancamento.descricao) */
  anbimaDescricao?: string | null;
  /** Grupo ANBIMA do lançamento (ex: "Taxas do Fundo", "Movimentação de Cotas") */
  anbimaGrupo?: string | null;
  // Imoveis fields
  logradouro?: string;
  numero?: string;
  complemento?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  nomecomercial?: string;
  percpart?: number;
  valorcontabil?: number;
  justificativa?: string;
  valoravaliacao?: number;
  tpavaliador?: string;
  cnpjcpfavaliador?: string;
  aluguelcontratado?: number;
  aluguelatrasado?: number;
  opcaorecompra?: string;
  dtopcaorecompra?: string;
  tipoimovel?: string;
  questjur?: string;
  motivoquestjur?: string;
  tipouso?: string;
  matricula?: string;
  cnpjemp?: string;
  // Enriquecimento Finvest CSV (presentes quando view vw_posicao_enriquecida é usada)
  enr_subcategoria?: string | null;
  enr_categoria_detalhada?: string | null;
  enr_nivel_granularidade?: string | null;
  enr_status_consolidacao?: string | null;
  enr_tem_csv?: boolean | null;
}

export interface PathAssetData {
  assets: Asset[];
  cotasComPosicao: Set<string>;
  totalPL: number;
}

const SECTION_LABEL: Record<string, string> = {
  caixa: "Caixa",
  provisao: "Provisão",
  despesas: "Despesas",
  participacoes: "Participações",
  cotas: "Cotas",
  titpublico: "Títulos públicos",
  titprivado: "Títulos privados",
  fidc: "Direitos creditórios",
  acoes: "Ações",
  imoveis: "Imóveis",
  termorf: "Termo RF",
  outros: "Outros",
};
const SECTION_TABLE_LABEL: Record<string, string> = {
  titpublico: "Tít. públicos",
  titprivado: "Tít. privados",
  fidc: "Dir. creditórios",
  participacoes: "Participações",
};

interface WalletTableProps {
  assets: Asset[];
  totalPL: number;
  onSelectAsset: (asset: Asset) => void;
  resgatesSolicitados?: number | null;
  onResgatesSolicitadosChange?: (val: number | null) => void;
  showPrazosEmDias?: boolean;
  className?: string;
  /** Set de CNPJs de cotas que possuem posição/XML importado */
  cotasComPosicao?: Set<string>;
  /** Data da posição (YYYYMMDD) para sub-fundos */
  fundoDtPosicao?: string;
  /** Usar explosão inline (expandir na mesma página) em vez de navegar */
  inlineExplosao?: boolean;
  /** Caminho de CNPJs expandidos (recursivo) */
  expandedCotaPath?: string[];
  /** Callback ao expandir/recolher cota em um nível */
  onExpandCotaAtLevel?: (level: number, cnpj: string | null) => void;
  /** Dados dos sub-fundos para cada nível do path */
  pathAssetsData?: PathAssetData[];
  /** Nível atual (0 = tabela principal, 1+ = aninhado) - uso interno */
  _depth?: number;
  /** Modo compacto (apenas tabela, sem cabeçalho) para níveis aninhados - uso interno */
  _compact?: boolean;
  /**
   * Quando true, exibe provisões linha-a-linha com descrição ANBIMA
   * em vez de consolidá-las em um único registro "Provisão (consolidado)".
   */
  showProvisaoDetalhada?: boolean;
}

export function WalletTable({ assets, totalPL, onSelectAsset, resgatesSolicitados, onResgatesSolicitadosChange, showPrazosEmDias, className, cotasComPosicao, fundoDtPosicao, inlineExplosao, expandedCotaPath = [], onExpandCotaAtLevel, pathAssetsData = [], _depth = 0, _compact = false, showProvisaoDetalhada = false }: WalletTableProps) {
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [sort, setSort] = useState("original");
  const tableAssets = (() => {
    if (showProvisaoDetalhada) return assets;

    const provisoes = assets.filter((a) => (a.section || "").toLowerCase() === "provisao");
    if (provisoes.length <= 1) return assets;

    const firstProvisaoIndex = assets.findIndex((a) => (a.section || "").toLowerCase() === "provisao");
    const totalProvisao = provisoes.reduce((sum, a) => {
      const base = a.valor_padrao || 0;
      return sum + (a.credeb === "D" ? -base : base);
    }, 0);

    const provisaoAggregada: Asset = {
      ...provisoes[0],
      id: "provisao-agrupada",
      nome_comercial_ativo: "Provisão (consolidado)",
      qtdisponivel: null as unknown as number,
      puposicao: null as unknown as number,
      valor_padrao: Math.abs(totalProvisao),
      credeb: totalProvisao < 0 ? "D" : "C",
      isSectionAggregate: true,
      prazo_pagamento_resgate_dias: null,
      validado: true,
    };

    const compacted = assets.filter((a) => (a.section || "").toLowerCase() !== "provisao");
    compacted.splice(firstProvisaoIndex, 0, provisaoAggregada);
    return compacted;
  })();

  const sectionOptions = [
    { value: "", label: "Todas as classes" },
    ...Array.from(new Set(tableAssets.map((asset) => asset.section).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "pt-BR"))
      .map((section) => ({ value: section, label: SECTION_LABEL[section.toLowerCase()] || section })),
  ];
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const visibleAssets = tableAssets
    .filter((asset) => {
      if (sectionFilter && asset.section !== sectionFilter) return false;
      if (!normalizedSearch) return true;
      return [
        asset.anbimaDescricao, asset.nome_comercial_ativo, asset.nomecomercial,
        asset.codativo, asset.isin, asset.cnpjfundo, asset.cnpjemissor,
        asset.anbimaGrupo, asset.section,
      ].some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(normalizedSearch));
    })
    .sort((a, b) => {
      if (sort === "financeiro-desc") return Math.abs(b.valor_padrao ?? 0) - Math.abs(a.valor_padrao ?? 0);
      if (sort === "financeiro-asc") return Math.abs(a.valor_padrao ?? 0) - Math.abs(b.valor_padrao ?? 0);
      if (sort === "ativo") return (a.anbimaDescricao || a.nome_comercial_ativo || a.codativo || "")
        .localeCompare(b.anbimaDescricao || b.nome_comercial_ativo || b.codativo || "", "pt-BR");
      return 0;
    });
  const visibleTotal = visibleAssets.reduce((sum, asset) =>
    sum + (asset.credeb === "D" ? -1 : 1) * (asset.valor_padrao ?? 0), 0);
  const formatNumber = (value: number, fractionDigits = 2) =>
    new Intl.NumberFormat("pt-BR", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);

  return (
    <div className={cn("wallet-assets", _compact && "wallet-assets--compact", className)}>
      {!_compact && (
        <div className="wallet-section-heading">
          <div>
            <div className="wallet-eyebrow">Posição detalhada</div>
            <h2>Composição da carteira</h2>
            <p>Ativos e lançamentos da posição · {tableAssets.length} registros</p>
          </div>
          <div className="wallet-assets__filters">
            <Input id="wallet-asset-search" label="Buscar ativo" icon="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, ISIN ou CNPJ" size="sm" />
            <Select id="wallet-asset-section" label="Classe" value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} options={sectionOptions} size="sm" />
            <Select id="wallet-asset-sort" label="Ordenar" value={sort} onChange={(event) => setSort(event.target.value)} options={[
              { value: "original", label: "Ordem da posição" },
              { value: "financeiro-desc", label: "Maior financeiro" },
              { value: "financeiro-asc", label: "Menor financeiro" },
              { value: "ativo", label: "Ativo A–Z" },
            ]} size="sm" />
          </div>
        </div>
      )}

      <Card className="wallet-assets__panel" padding={false}>
        <div className="wallet-assets__scroll">
        <Table className={cn("wallet-assets__table", showPrazosEmDias && "wallet-assets__table--with-prazos")}>
          <TableHeader>
            <TableRow>
              <TableHead className="wallet-assets__first">Ativo / Emissor</TableHead>
              <TableHead className="text-center">Tipo</TableHead>
              <TableHead className="text-right">Quantidade</TableHead>
              <TableHead className="text-right whitespace-nowrap">Preço unitário</TableHead>
              <TableHead className="text-center">Liquidez ANBIMA</TableHead>
              {showPrazosEmDias && (
                <>
                  <TableHead className="text-center">Prazos (dias)</TableHead>
                  <TableHead className="text-center">Vértice</TableHead>
                </>
              )}
              <TableHead className="text-right">Financeiro</TableHead>
              <TableHead className="text-right">% PL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleAssets.map((asset, index) => {
              const share = totalPL ? ((asset.valor_padrao || 0) / totalPL) : 0;
              const cnpj = asset.cnpjfundo || asset.cnpjemissor;
              const prazoLiquidez = asset.section?.toLowerCase() === "caixa"
                ? 0
                : (asset.prazo_pagamento_resgate_dias ?? null);
              
              const isProvisao = (asset.section || "").toLowerCase() === "provisao";
              const provisaoFallback = isProvisao && asset.codprov
                ? `Lançamento cód. ${asset.codprov}`
                : undefined;
              const displayName = asset.section === 'imoveis'
                ? (asset.nomecomercial || (asset.logradouro ? `${asset.logradouro}${asset.numero ? `, ${asset.numero}` : ""}` : undefined))
                : (asset.anbimaDescricao || asset.nome_comercial_ativo || provisaoFallback || asset.isin || asset.codativo);

              const isCotaComPosicao = (asset.section || "").toLowerCase() === "cotas" && asset.cnpjfundo && cotasComPosicao?.has(asset.cnpjfundo) && fundoDtPosicao;
              const isThisCotaExpanded = inlineExplosao && expandedCotaPath[_depth] === asset.cnpjfundo;
              
              // Rótulo de classificação Finvest CSV (mostrado quando XML é genérico)
              const enrLabel = (() => {
                if (!asset.enr_tem_csv) return null;
                const sec = asset.section?.toLowerCase();
                // Só exibe para seções onde o XML costuma ser genérico
                if (!['provisao', 'caixa', 'despesas'].includes(sec)) return null;
                return asset.enr_categoria_detalhada || asset.enr_subcategoria || null;
              })();

              const colSpan = 7 + (showPrazosEmDias ? 2 : 0);
              const rowKey = `${asset.id ?? "asset"}-${asset.section}-${index}`;

              return (
                <Fragment key={rowKey}>
                <TableRow className="wallet-assets__row group">
                  <TableCell className="wallet-assets__first">
                    <div className="flex flex-col justify-center h-full">
                      <div className="wallet-assets__identity">
                        <button 
                          onClick={() => {
                            if (!asset.isSectionAggregate) onSelectAsset(asset);
                          }}
                          className={cn("wallet-assets__name", asset.isSectionAggregate && "wallet-assets__name--static")}
                          disabled={asset.isSectionAggregate}
                          title={displayName || SECTION_LABEL[asset.section.toLowerCase()] || "Outros lançamentos"}
                        >
                          <span className="wallet-assets__name-text">
                            {displayName || SECTION_LABEL[asset.section.toLowerCase()] || "Outros lançamentos"}
                          </span>
                          {!asset.isSectionAggregate && (cnpj || asset.section === 'imoveis') && !isCotaComPosicao && <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />}
                          {asset.validado === false && <Badge tone="warning">Pendente</Badge>}
                        </button>
                        {isCotaComPosicao && inlineExplosao && onExpandCotaAtLevel && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="layers"
                            className="wallet-assets__expand"
                            onClick={(e) => {
                              e.stopPropagation();
                              onExpandCotaAtLevel(_depth, isThisCotaExpanded ? null : asset.cnpjfundo || null);
                            }}
                            title={isThisCotaExpanded ? "Recolher composição" : "Ver composição do sub-fundo"}
                          >
                            {isThisCotaExpanded ? "Recolher" : "Ver composição"}
                          </Button>
                        )}
                      </div>
                      <div className="wallet-assets__meta">
                        {asset.codprov ? (
                          <span className="opacity-70">Cód. {asset.codprov}</span>
                        ) : (
                          <span className={cn(!asset.isin && "opacity-40")}>
                            {asset.isin || (asset.cnpjemissor ? "CNPJ EMISSOR" : "SEM ISIN")}
                          </span>
                        )}
                        {!asset.codprov && cnpj && (
                          <>
                            <span className="wallet-assets__meta-separator" />
                            <span>{cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}</span>
                          </>
                        )}
                        {enrLabel && (
                          <>
                            <span className="wallet-assets__meta-separator" />
                            <span className="text-primary/60 not-italic">{enrLabel}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge tone="neutral" title={asset.anbimaGrupo || SECTION_LABEL[asset.section.toLowerCase()] || asset.section}>
                      {asset.anbimaGrupo || SECTION_TABLE_LABEL[asset.section.toLowerCase()] || SECTION_LABEL[asset.section.toLowerCase()] || asset.section}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {asset.qtdisponivel != null ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(asset.qtdisponivel) : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {asset.puposicao != null ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4, minimumFractionDigits: 2 }).format(asset.puposicao) : '-'}
                  </TableCell>
                  <TableCell className="text-center">
                    {prazoLiquidez != null ? (
                      <span className={cn(
                        "wallet-assets__liquidity",
                        prazoLiquidez <= 10 ? "wallet-assets__liquidity--short" :
                        prazoLiquidez <= 30 ? "wallet-assets__liquidity--medium" :
                        prazoLiquidez <= 60 ? "wallet-assets__liquidity--long" : "wallet-assets__liquidity--critical"
                      )}>
                        D+{prazoLiquidez}
                      </span>
                    ) : (
                      <span className="wallet-assets__nodata">N/D</span>
                    )}
                  </TableCell>
                  {showPrazosEmDias && (
                    <>
                      <TableCell className="text-center">
                        {asset.prazos_em_dias != null ? asset.prazos_em_dias : "–"}
                      </TableCell>
                      <TableCell className="text-center">
                        {asset.vertice != null ? (asset.vertice === 1260 ? "D+720+" : `D+${asset.vertice}`) : "–"}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">
                    <span className={cn(
                      asset.credeb === 'D' ? "wallet-assets__negative" : "wallet-assets__amount"
                    )}>
                      {asset.valor_padrao != null ? 
                        (asset.credeb === 'D' ? "-" : "") + 
                        new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(asset.valor_padrao) 
                        : '-'
                      }
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                     <span className={cn(
                        "wallet-assets__pct",
                        asset.credeb === 'D' ? "wallet-assets__negative" : (share > 0.05 ? "wallet-assets__significant" : "wallet-assets__share")
                      )}>
                        {share ? (asset.credeb === 'D' ? "-" : "") + formatNumber(share * 100) + "%" : "0,00%"}
                      </span>
                  </TableCell>
                </TableRow>
                {isThisCotaExpanded && pathAssetsData[_depth] && pathAssetsData[_depth].assets.length > 0 && (
                  <TableRow className="bg-muted/10 hover:bg-muted/10">
                    <TableCell colSpan={colSpan} className="p-0 border-b border-border/40">
                      <div className="wallet-assets__subfund">
                        <p className="wallet-assets__subfund-title">
                          Composição do sub-fundo
                        </p>
                        <WalletTable
                          assets={pathAssetsData[_depth].assets}
                          totalPL={pathAssetsData[_depth].totalPL}
                          onSelectAsset={onSelectAsset}
                          cotasComPosicao={pathAssetsData[_depth].cotasComPosicao}
                          fundoDtPosicao={fundoDtPosicao}
                          inlineExplosao={inlineExplosao}
                          expandedCotaPath={expandedCotaPath}
                          onExpandCotaAtLevel={onExpandCotaAtLevel}
                          pathAssetsData={pathAssetsData}
                          _depth={_depth + 1}
                          _compact={true}
                          showPrazosEmDias={false}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              );
            })}
            {visibleAssets.length === 0 && (
              <TableRow><TableCell colSpan={7 + (showPrazosEmDias ? 2 : 0)} className="wallet-assets__empty">
                Nenhum ativo encontrado para os filtros selecionados.
              </TableCell></TableRow>
            )}
          </TableBody>
          {visibleAssets.length > 0 && (
            <tfoot>
              <TableRow className="wallet-assets__total">
                <TableCell colSpan={5 + (showPrazosEmDias ? 2 : 0)}>Total exibido · {visibleAssets.length} registros</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(visibleTotal)}</TableCell>
                <TableCell className="text-right font-mono">{totalPL ? formatNumber((visibleTotal / totalPL) * 100) : "0,00"}%</TableCell>
              </TableRow>
            </tfoot>
          )}
        </Table>
        </div>
      </Card>
    </div>
  );
}
