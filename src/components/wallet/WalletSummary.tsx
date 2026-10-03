import React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { Card } from "@/design-system/components/core/Card";

interface WalletSummaryProps {
  totalPL: number;
  summary: Record<string, number>;
  className?: string;
  extraCardAfterCaixa?: React.ReactNode;
  onSectionClick?: (section: string) => void;
  activeDrillSection?: string | null;
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

function formatCompactBRL(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) {
    return `${sign}R$ ${(abs / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  }
  if (abs >= 1_000) {
    return `${sign}R$ ${(abs / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  }
  return `${sign}${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(abs)}`;
}

function formatPct(value: number, pl: number): string {
  if (!pl) return "—";
  const pct = (value / pl) * 100;
  if (!Number.isFinite(pct)) return "—";
  const abs = Math.abs(pct);
  if (abs >= 1000) return `${pct < 0 ? "−" : ""}${(abs / 1000).toFixed(1)} mil%`;
  return `${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function WalletSummary({
  totalPL,
  summary,
  className,
  extraCardAfterCaixa,
  onSectionClick,
  activeDrillSection,
}: WalletSummaryProps) {
  const sections = Object.entries(summary).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const hasCaixa = sections.some(([s]) => s.toLowerCase() === "caixa");

  return (
    <Card className={cn("wallet-summary", className)} padding={false}>
      <div className="wallet-summary__primary">
        <div>
          <div className="wallet-eyebrow">Visão da posição</div>
          <h2>Composição patrimonial</h2>
          <p>Valores consolidados da carteira na data de referência</p>
        </div>
        <div className="wallet-summary__pl">
          <span>Patrimônio líquido</span>
          <strong>{formatCompactBRL(totalPL)}</strong>
        </div>
      </div>
      <div className="wallet-summary__metrics">
        {sections.map(([section, value]) => {
        const key = section.toLowerCase();
        const label = SECTION_LABEL[key] || section;
        const isClickable = !!onSectionClick;
        const isActive = activeDrillSection === key;
        const isNeg = value < 0;

        return (
          <React.Fragment key={section}>
            <button
              type="button"
              className={cn("wallet-summary__metric", isActive && "is-active", isNeg && "is-negative")}
              onClick={isClickable ? () => onSectionClick(key) : undefined}
              disabled={!isClickable}
              aria-pressed={isClickable ? isActive : undefined}
              aria-label={`${label}: ${formatCompactBRL(value)}, ${formatPct(value, totalPL)} do PL`}
            >
              <span className="wallet-summary__metric-label">
                {label}
                {isClickable && <ChevronDown aria-hidden="true" className={cn(isActive && "is-open")} />}
              </span>
              <strong>{formatCompactBRL(value)}</strong>
              <span className="wallet-summary__metric-share">
                {formatPct(value, totalPL)} do PL
              </span>
            </button>
            {key === "caixa" && extraCardAfterCaixa}
          </React.Fragment>
        );
        })}
        {extraCardAfterCaixa && !hasCaixa && extraCardAfterCaixa}
      </div>
    </Card>
  );
}
