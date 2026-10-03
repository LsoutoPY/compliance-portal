import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-semibold text-foreground">{titulo}</h4>
      <div className="text-[11px] leading-relaxed text-muted-foreground space-y-1">
        {children}
      </div>
    </section>
  );
}

function Item({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <p className="flex gap-1.5">
      <span className={cn("shrink-0 font-bold", ok ? "text-emerald-600" : "text-red-600")}>
        {ok ? "✓" : "✗"}
      </span>
      <span>{children}</span>
    </p>
  );
}

export function TributarioRegraInfoDialog({ className }: { className?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 shrink-0 text-muted-foreground hover:text-primary", className)}
          aria-label="Como esta regra é calculada"
        >
          <Info className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="text-base pr-6">
            TRIB_FIQ_LP_90 — Cotas LP tributário (MM-10d)
          </DialogTitle>
          <DialogDescription className="text-xs">
            IN RFB 1.585/2015, Art. 5º — fundos de investimento em quotas (FIQ)
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(85vh-7rem)] px-5 py-4">
          <div className="space-y-4 pr-3">
            <Secao titulo="O que a regra exige">
              <p>
                O FIQ deve manter, em cada dia, uma <strong className="text-foreground">média móvel de 10 dias úteis (MM-10d)</strong> de
                pelo menos <strong className="text-foreground">90%</strong> do patrimônio investido em cotas classificadas como{" "}
                <strong className="text-foreground">longo prazo (LP) tributário</strong>.
              </p>
              <p>
                Na linha resumo acima: <strong className="text-foreground">% calculado = MM-10d</strong> do dia (não é só o percentual
                do dia isolado). <strong className="text-foreground">p do dia</strong> aparece nos cartões LP/CP abaixo.
              </p>
            </Secao>

            <Secao titulo="Base do cálculo (Art. 5º)">
              <p>
                Percentual do <strong className="text-foreground">patrimônio líquido (PL)</strong> investido em cotas e títulos
                classificados como <strong className="text-foreground">longo prazo (LP) tributário</strong> — mesma lógica do
                relatório de duration/prazo médio do administrador.
              </p>
              <p className="font-mono text-[10px] bg-muted/60 rounded px-2 py-1.5 text-foreground">
                p do dia = valor LP ÷ PL do fundo × 100
              </p>
              <p>
                <strong className="text-foreground">Numerador:</strong> soma das cotas e títulos RF classificados como LP.
              </p>
              <p>
                <strong className="text-foreground">Denominador:</strong> configurável na regra{" "}
                <code className="text-[10px] bg-muted px-1 rounded">TRIB_FIQ_LP_90</code> — padrão{" "}
                <code className="text-[10px] bg-muted px-1 rounded">fundo_patliq</code> (PL total do XML); opcionalmente
                PL − ativos excluídos (carteira elegível, ex.: FII fora do denominador).
              </p>
              <p>
                Cotas de FII nunca entram no numerador LP (Art. 4º §5º VIII). Com PL total, o FII permanece no denominador
                e reduz o p do dia; com carteira elegível, o FII sai também do denominador.
              </p>
              <p>
                Os % nos cartões LP / CP / Excluído e na lista de ativos usam o <strong className="text-foreground">PL</strong> como base.
              </p>
            </Secao>

            <Secao titulo="Títulos RF (titpublico / titprivado)">
              <p>
                LFT, Tesouro Selic, NTN, CDB, debêntures etc. entram pelo{" "}
                <code className="text-[10px] bg-muted px-1 rounded">valor_padrao</code> da posição.
              </p>
              <Item ok>
                <strong>LP:</strong> <code className="text-[10px]">dtvencimento</code> mais de 366 dias corridos após a data da posição.
              </Item>
              <Item ok={false}>
                <strong>CP:</strong> vencimento em até 366 dias, ou sem data de vencimento válida.
              </Item>
            </Secao>

            <Secao titulo="Como cada cota vira LP ou CP">
              <p>Ordem de decisão para cotas (cadastro ANBIMA / fundos_caracteristicas):</p>
              <ol className="list-decimal list-inside space-y-0.5 pl-0.5">
                <li>
                  <strong>tributacao_alvo:</strong> Longo Prazo, Alíquota de 15%, Isento → LP; Curto Prazo → CP.
                </li>
                <li>
                  <strong>DI / Selic D+0</strong> (prazo 0) → CP, apenas se tributacao_alvo não definiu LP/CP.
                </li>
                <li>
                  <strong>FII</strong> → não conta como LP (fora do numerador); permanece no PL.
                </li>
                <li>
                  <strong>FIA / FIP:</strong> LP só se a carteira já tiver ≥ 50% LP antes deles (§3º Art. 5º); senão CP.
                </li>
                <li>
                  <strong>Fallback por prazo de resgate:</strong> &gt; 365 dias → LP; ≤ 365 dias ou aberto sem prazo → CP.
                </li>
              </ol>
            </Secao>

            <Secao titulo="Média móvel e status">
              <p>
                MM-10d = <strong className="text-foreground">média aritmética simples (SMA)</strong> dos{" "}
                <strong className="text-foreground">p do dia</strong> das últimas 10 posições da carteira
                (posição atual + até 9 anteriores). Com histórico incompleto, divide pelos dias disponíveis.
              </p>
              <p className="font-mono text-[10px] bg-muted/60 rounded px-2 py-1.5 text-foreground">
                MM-10d = soma dos últimos p_dia (até 10) ÷ quantidade de posições na janela
              </p>
              <p className="text-[10px] text-muted-foreground">
                Metodologia: <code className="bg-muted px-1 rounded">sma10-v2</code> — sem memória infinita;
                o 11º dia anterior sai automaticamente da janela. Processar checks em ordem cronológica.
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>
                  <strong className="text-emerald-600">Enquadrado:</strong> MM-10d ≥ 92%
                </li>
                <li>
                  <strong className="text-amber-600">Atenção:</strong> 90% ≤ MM-10d &lt; 92%, ou abaixo de 90% sem estourar limites anuais
                </li>
                <li>
                  <strong className="text-red-600">Violação:</strong> MM-10d &lt; 90% com ≥ 3 eventos ou ≥ 45 dias em violação no ano
                </li>
              </ul>
            </Secao>

            <Secao titulo="O que não entra no cálculo">
              <Item ok={false}>Resgates pendentes (não há base no Art. 5º para estimativa no numerador).</Item>
              <Item ok={false}>Caixa e saldos fora da section cotas.</Item>
              <Item ok={false}>Provisões e diferenças de arredondamento do PL do XML no denominador.</Item>
            </Secao>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
