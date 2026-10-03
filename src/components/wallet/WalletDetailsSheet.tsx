import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Loader2, Info, ShieldCheck, Target, Building2, UserCheck, Layers, MapPin, BadgeDollarSign, Scale, CalendarDays, FileText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  dedupeCaracteristicasLinhas,
  normalizeCnpj14,
  pickCaracteristicaParaPosicao,
  preferEstruturaClasseFundo,
} from "@/lib/liquidezFundosCaracteristicas";
import { Asset } from "./WalletTable";

function enrichCaracteristicaDetalhes(allRows: Record<string, unknown>[], picked: Record<string, unknown> | null) {
  if (!picked) return null;

  const pickField = (key: string): unknown => {
    const pv = picked[key];
    if (pv != null && String(pv).trim() !== "") return pv;
    const prefer = allRows.filter((r) => preferEstruturaClasseFundo(r as any));
    for (const r of prefer) {
      const v = r[key];
      if (v != null && String(v).trim() !== "") return v;
    }
    for (const r of allRows) {
      const v = r[key];
      if (v != null && String(v).trim() !== "") return v;
    }
    return pv;
  };

  return {
    ...picked,
    quantidade_subclasses: pickField("quantidade_subclasses"),
    gestor_principal: pickField("gestor_principal"),
    administrador: pickField("administrador"),
    data_inicio_atividade: pickField("data_inicio_atividade"),
    tipo_investidor: pickField("tipo_investidor"),
    caracteristica_investidor: pickField("caracteristica_investidor"),
  } as Record<string, unknown>;
}

/** ANBIMA N1 permanece a categoria (ex.: FIDC); indica fundo de classe única quando a planilha/nome assim definirem. */
function formatNivel1ClasseDisplay(
  details: Record<string, unknown> | null,
  nomeAtivoCarteira?: string | null,
): string | undefined {
  if (!details) return undefined;
  const n1 = details.nivel1_categoria != null ? String(details.nivel1_categoria) : "";
  const qtdRaw = details.quantidade_subclasses;
  const qtdNum = typeof qtdRaw === "number" ? qtdRaw : Number(qtdRaw);
  const nome = String(details.nome_comercial ?? nomeAtivoCarteira ?? "").toUpperCase();
  const isClasseUnica =
    qtdNum === 1 ||
    /\bCLASSE\s+ÚNICA\b/u.test(nome) ||
    /\bCLASSE\s+UNICA\b/u.test(nome);
  if (!n1) return undefined;
  if (isClasseUnica) return `${n1} — Classe única`;
  return n1;
}

interface WalletDetailsSheetProps {
  asset: Asset | null;
  onClose: () => void;
}

export function WalletDetailsSheet({ asset, onClose }: WalletDetailsSheetProps) {
  const cnpjRaw = asset?.cnpjfundo || asset?.cnpjemissor;
  const cnpj = normalizeCnpj14(cnpjRaw) ?? String(cnpjRaw ?? "").replace(/\D/g, "");
  const isImovel = asset?.section === 'imoveis';

  const { data: details, isLoading } = useQuery({
    queryKey: ["fund-details", cnpj, asset?.isin],
    enabled: !!cnpj && !isImovel,
    queryFn: async () => {
      if (!cnpj) return null;
      const { data: dClasse, error: e1 } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("*")
        .eq("cnpj_classe", cnpj);
      const { data: dFundo, error: e2 } = await supabase
        .from("fundos_caracteristicas" as any)
        .select("*")
        .eq("cnpj_fundo", cnpj);
      const err = e1 || e2;
      if (err) throw err;
      const raw = [...(dClasse || []), ...(dFundo || [])];
      const rows = dedupeCaracteristicasLinhas(raw as any);
      const picked = pickCaracteristicaParaPosicao(rows as any, cnpj, asset?.isin);
      return enrichCaracteristicaDetalhes(rows as any, picked as any);
    },
  });

  const isin = asset?.isin ? String(asset.isin).trim() : null;
  const { data: ativoData } = useQuery({
    queryKey: ["ativo-liquidez", isin],
    enabled: !!isin && !isImovel,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ativos" as any)
        .select("data_liquidez_prevista")
        .eq("isin", isin!)
        .maybeSingle();
      if (error) throw error;
      return data as { data_liquidez_prevista: string | null } | null;
    },
  });

  const formatCurrency = (value?: number) => {
    if (value === undefined || value === null) return "Não informado";
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "Não informado";
    return dateStr.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
  };

  const formatFundStartDate = (value?: string) => {
    if (!value) return "Não informado";

    const raw = String(value).trim();
    if (!raw) return "Não informado";

    if (/^\d{8}$/.test(raw)) {
      return raw.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split("-");
      return `${d}/${m}/${y}`;
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("pt-BR");
    }

    return raw;
  };

  return (
    <Sheet open={!!asset} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md border-l border-border/60 shadow-2xl overflow-y-auto bg-background p-0">
        <SheetHeader className="px-6 py-5 border-b border-border bg-muted/10">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center justify-center h-6 w-6 rounded bg-primary/10 text-primary">
              {isImovel ? <MapPin className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
              {isImovel ? "Detalhes do Imóvel" : "Detalhes do Ativo"}
            </span>
          </div>
            <SheetTitle className="text-lg font-semibold leading-tight">
            {isImovel ? (asset?.nomecomercial || asset?.logradouro) : ((details?.nome_comercial as string) || asset?.nome_comercial_ativo || "Carregando informações...")}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs text-muted-foreground">
            {isImovel ? `Matrícula: ${asset?.matricula || "N/A"}` : `CNPJ: ${cnpj?.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}`}
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground animate-pulse font-medium">Sincronizando dados...</p>
          </div>
        ) : isImovel ? (
          <div className="p-6 space-y-8 animate-in fade-in duration-300">
            <Section title="Localização" icon={MapPin}>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{asset?.logradouro}, {asset?.numero}</p>
                {asset?.complemento && <p className="text-xs text-muted-foreground">{asset.complemento}</p>}
                <p className="text-xs text-muted-foreground">{asset?.cidade} - {asset?.estado} | CEP: {asset?.cep}</p>
              </div>
            </Section>

            <Section title="Valores e Avaliação" icon={BadgeDollarSign}>
              <div className="grid grid-cols-2 gap-4">
                <InfoItem label="Valor Contábil" value={formatCurrency(asset?.valorcontabil)} />
                <InfoItem label="Valor Avaliação" value={formatCurrency(asset?.valoravaliacao)} />
                <InfoItem label="Aluguel Contratado" value={formatCurrency(asset?.aluguelcontratado)} />
                <InfoItem label="Aluguel Atrasado" value={formatCurrency(asset?.aluguelatrasado)} />
              </div>
              <div className="mt-4 pt-4 border-t border-border/40">
                <InfoItem label="Avaliador" value={asset?.tpavaliador || "Não informado"} />
                <InfoItem label="CNPJ/CPF Avaliador" value={asset?.cnpjcpfavaliador || "Não informado"} />
              </div>
            </Section>

            <Section title="Jurídico e Uso" icon={Scale}>
              <div className="grid grid-cols-2 gap-4">
                <InfoItem label="Tipo de Imóvel" value={asset?.tipoimovel || "Não informado"} />
                <InfoItem label="Tipo de Uso" value={asset?.tipouso || "Não informado"} />
              </div>
              <div className="mt-4 space-y-3">
                <InfoItem label="Questão Jurídica" value={asset?.questjur === 'S' ? "Sim" : "Não"} />
                {asset?.questjur === 'S' && (
                  <div className="p-3 bg-red-50 rounded-lg border border-red-100">
                    <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Motivo</p>
                    <p className="text-xs text-red-600 leading-relaxed">{asset?.motivoquestjur}</p>
                  </div>
                )}
              </div>
            </Section>

            <Section title="Outras Informações" icon={FileText}>
              <div className="grid grid-cols-2 gap-4">
                <InfoItem label="Opção Recompra" value={asset?.opcaorecompra === 'S' ? "Sim" : "Não"} />
                <InfoItem label="Data Recompra" value={formatDate(asset?.dtopcaorecompra)} />
              </div>
              <div className="mt-4">
                <InfoItem label="Justificativa" value={asset?.justificativa || "Sem justificativa"} />
              </div>
            </Section>
          </div>
        ) : details ? (
          <div className="p-6 space-y-8">
            <Section title="Institucional" icon={ShieldCheck}>
              <InfoItem label="Gestor" value={details.gestor_principal} icon={Target} />
              <InfoItem label="Administrador" value={details.administrador} icon={Building2} />
              <InfoItem label="Data de Início" value={formatFundStartDate(details.data_inicio_atividade)} icon={CalendarDays} />
              {ativoData?.data_liquidez_prevista && (
                <InfoItem
                  label="Liquidez prevista"
                  value={formatFundStartDate(ativoData.data_liquidez_prevista)}
                  icon={CalendarDays}
                />
              )}
            </Section>

            <Section title="Perfil" icon={UserCheck}>
              <div className="grid grid-cols-2 gap-4">
                <InfoItem label="Investidor" value={details.tipo_investidor} />
                <InfoItem label="Característica" value={details.caracteristica_investidor} />
              </div>
            </Section>

            <Section title="Classificação ANBIMA" icon={Layers}>
              <div className="space-y-3 bg-muted/20 p-3 rounded-md border border-border/50">
                <LevelItem level="N1" label="Classe" value={formatNivel1ClasseDisplay(details, asset?.nome_comercial_ativo)} />
                <LevelItem level="N2" label="Tipo" value={details.nivel2_categoria} />
                <LevelItem level="N3" label="Estratégia" value={details.nivel3_subcategoria} />
              </div>
            </Section>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 space-y-3 text-center px-6">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <Info className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Dados indisponíveis</p>
              <p className="text-xs text-muted-foreground">
                Não localizamos ficha cadastral para este CNPJ.
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b border-border pb-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{title}</h3>
      </div>
      <div className="space-y-3">
        {children}
      </div>
    </div>
  );
}

function InfoItem({ label, value, icon: Icon }: { label: string; value: string; icon?: any }) {
  return (
    <div className="space-y-0.5">
      <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider block mb-0.5">{label}</span>
      <p className="text-sm font-medium text-foreground flex items-center gap-2">
        {Icon && <Icon className="h-3 w-3 text-muted-foreground/70" />}
        {value || "Não informado"}
      </p>
    </div>
  );
}

function LevelItem({ level, label, value }: { level: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 px-1.5 py-0.5 bg-background rounded border border-border">
        <span className="text-[9px] font-bold text-muted-foreground">{level}</span>
      </div>
      <div>
        <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider block mb-0.5">{label}</span>
        <p className="text-xs font-semibold">{value || "-"}</p>
      </div>
    </div>
  );
}
