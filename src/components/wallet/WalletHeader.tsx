import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/design-system/components/core/Button";
import { IconButton } from "@/design-system/components/core/IconButton";
import { Badge } from "@/design-system/components/core/Badge";
import type { PatliqOrigem } from "@/lib/patliqContext";
import { resolveStoredComplianceStatus } from "@/lib/fipClasseCompliance";
import { effectiveTribArt4Status } from "@/components/enquadramento/TribFimPrazoMedio";
import { effectiveMinAlocacaoStatus, isRegraMinAlocacaoFidc } from "@/lib/minAlocacaoContadores";
import { fundoRegrasIsinQueryValues, resolveFundoRegrasForIsin } from "@/lib/fundoRegrasUtils";

interface WalletHeaderProps {
  fundName: string;
  fundCnpj: string;
  fundDate: string;
  isin?: string | null;
  prazoResgateDias?: number | null;
  xmlPL?: number;
  csvPL?: number;
  plHeaderRaw?: number;
  patliqOrigem?: PatliqOrigem;
  hasPLDiscrepancy?: boolean;
  onRunCheck?: () => void;
  isRunningCheck?: boolean;
  showRulesPanel: boolean;
  toggleRulesPanel: () => void;
  onExportPdf?: () => void;
  isExporting?: boolean;
  onExportExcel?: () => void;
  isExportingExcel?: boolean;
  onNotificar?: () => void;
  isNotifying?: boolean;
  canNotificar?: boolean;
  className?: string;
  backPath?: string;
  backLabel?: string;
  showEnquadramentoActions?: boolean;
  onShowInvestidores?: () => void;
}

const formatBRL = (value: number | undefined) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value ?? 0);

export function WalletHeader({
  fundName, fundCnpj, fundDate, isin, prazoResgateDias, xmlPL, csvPL, plHeaderRaw,
  patliqOrigem, hasPLDiscrepancy = false, onRunCheck, isRunningCheck = false,
  onExportPdf, isExporting = false, onExportExcel, isExportingExcel = false,
  onNotificar, isNotifying = false, canNotificar = false, className = "",
  backPath = "/enquadramento/monitoramento", backLabel = "Voltar para Monitoramento",
  showEnquadramentoActions = true, onShowInvestidores,
}: WalletHeaderProps) {
  const navigate = useNavigate();
  const { data: verification, isLoading: isLoadingStatus, isError: isStatusError } = useQuery({
    queryKey: ["fund-status-header", "v2", fundCnpj, fundDate, isin],
    enabled: !!fundCnpj && !!fundDate,
    queryFn: async () => {
      const digits = fundCnpj.replace(/\D/g, "").padStart(14, "0");
      const formatted = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
      const cnpjVariants = [...new Set([fundCnpj, digits, formatted])];
      let query = supabase
        .from("enquadramento_resultado" as any)
        .select("regra_codigo, regra_categoria, status, valor_atual, valor_limite, detalhes")
        .eq("fundo_cnpj", fundCnpj)
        .eq("fundo_dtposicao", fundDate);
      if (isin) query = (query as any).eq("fundo_isin", isin);
      const [{ data }, { data: associatedRaw }] = await Promise.all([
        query,
        supabase
          .from("fundo_regras")
          .select("fundo_isin, regra_id, regras_compliance (codigo)")
          .in("fundo_cnpj", cnpjVariants)
          .in("fundo_isin", fundoRegrasIsinQueryValues(isin))
          .eq("ativo", true)
          .eq("status_aprovacao", "ativo"),
      ]);
      const rules = (data || []) as Array<{
        regra_codigo: string;
        regra_categoria: string;
        status: string;
        valor_atual: number | null;
        valor_limite: number | null;
        detalhes: Record<string, unknown> | null;
      }>;
      const codesWithResult = new Set(rules.map((rule) => rule.regra_codigo));
      const associated = resolveFundoRegrasForIsin(associatedRaw, isin);
      const pendingCount = associated.filter((row) => {
        const complianceRule = Array.isArray(row.regras_compliance) ? row.regras_compliance[0] : row.regras_compliance;
        const code = (complianceRule as { codigo?: string } | null)?.codigo;
        return code && !codesWithResult.has(code);
      }).length;
      return { rules, pendingCount };
    },
  });

  const rules = verification?.rules ?? [];
  const pendingCount = verification?.pendingCount ?? 0;
  const statuses = rules.map((rule) => {
    const stored = resolveStoredComplianceStatus(rule);
    const code = (rule.regra_codigo || "").toUpperCase();
    const category = (rule.regra_categoria || "").toLowerCase();
    if (code === "TRIB_FIM_LP_365" || code === "TRIB_FIDC_LP_365" || category === "tributario-art4" || category === "tributario-art4-fidc") {
      return effectiveTribArt4Status(stored, rule.detalhes);
    }
    if (isRegraMinAlocacaoFidc(rule)) {
      return effectiveMinAlocacaoStatus(stored, rule.detalhes);
    }
    return stored;
  });
  const status = isLoadingStatus
    ? { label: "Carregando status", tone: "neutral" as const }
    : isStatusError
      ? { label: "Status indisponível", tone: "neutral" as const }
    : statuses.includes("violacao")
    ? { label: "Desenquadrado", tone: "negative" as const }
    : statuses.includes("alerta")
      ? { label: "Alerta compliance", tone: "warning" as const }
      : pendingCount > 0
        ? { label: "Verificação pendente", tone: "warning" as const }
        : rules.length > 0
          ? { label: "Regular", tone: "positive" as const }
          : { label: "Sem verificação", tone: "neutral" as const };

  return (
    <header className={`wallet-header ${className}`}>
      <Button variant="ghost" size="sm" icon="arrow-left" onClick={() => navigate(backPath)} className="wallet-header__back">
        {backLabel}
      </Button>
      <div className="wallet-header__main">
        <div className="wallet-header__identity">
          <div className="wallet-header__title-line">
            <h1>{fundName}</h1>
            <Badge tone={status.tone} dot>{status.label}</Badge>
          </div>
          <dl className="wallet-header__metadata">
            <div><dt>CNPJ</dt><dd>{fundCnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}</dd></div>
            <div><dt>Posição</dt><dd>{fundDate?.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1")}</dd></div>
            {isin && <div><dt>ISIN</dt><dd>{isin}</dd></div>}
            {prazoResgateDias != null && <div><dt>Resgate</dt><dd>D+{prazoResgateDias}</dd></div>}
          </dl>
          {((patliqOrigem === "fidc_header" && plHeaderRaw != null && plHeaderRaw !== xmlPL) || hasPLDiscrepancy) && (
            <div className="wallet-header__notices">
              {patliqOrigem === "fidc_header" && plHeaderRaw != null && plHeaderRaw !== xmlPL && (
                <Badge tone="info">PL FIDC ajustado: {formatBRL(xmlPL)}</Badge>
              )}
              {hasPLDiscrepancy && (
                <Badge tone="warning">Divergência de PL: XML {formatBRL(xmlPL)} · CSV {formatBRL(csvPL)}</Badge>
              )}
            </div>
          )}
        </div>
        {showEnquadramentoActions && (
          <div className="wallet-header__actions">
            {onShowInvestidores && <Button variant="secondary" size="sm" icon="git-merge" onClick={onShowInvestidores}>Quem investe aqui</Button>}
            <Button variant="primary" size="sm" icon="play-circle" onClick={onRunCheck} loading={isRunningCheck} disabled={!onRunCheck}>
              Rodar verificação
            </Button>
            <div className="wallet-header__exports" role="group" aria-label="Exportar carteira">
              <IconButton variant="secondary" size="sm" icon="file-down" label={isExporting ? "Exportando PDF" : "Exportar PDF"} onClick={onExportPdf} disabled={isExporting || !onExportPdf} />
              {onExportExcel && <IconButton variant="secondary" size="sm" icon="sheet" label={isExportingExcel ? "Exportando Excel" : "Exportar Excel"} onClick={onExportExcel} disabled={isExportingExcel} />}
            </div>
            {onNotificar && <Button variant="secondary" size="sm" icon="mail" onClick={onNotificar} loading={isNotifying} disabled={!canNotificar} title={canNotificar ? "Enviar e-mail de desenquadramento" : "Disponível apenas para fundos com violação"}>Notificar</Button>}
          </div>
        )}
      </div>
    </header>
  );
}
