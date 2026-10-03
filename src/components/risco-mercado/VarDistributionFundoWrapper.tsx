import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert } from "lucide-react";
import { useVarDistribution } from "@/hooks/useVarDistribution";
import { VarDistributionCharts } from "./VarDistributionCharts";

/**
 * Wrapper de loading/erro/dados para o painel de distribuição de retornos.
 * Montado apenas quando a linha do fundo está expandida — o fetch é lazy
 * e cacheado por CNPJ (staleTime 10 min).
 */
export function VarDistributionFundoWrapper({
  cnpj,
  nome,
  nObs21d,
  semMetricas,
}: {
  cnpj: string;
  nome: string;
  nObs21d?: number | null;
  semMetricas?: boolean;
}) {
  const { data, isLoading, error, refetch, isFetching } = useVarDistribution(cnpj, true);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[200px] w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Erro ao carregar série de retornos:{" "}
          {error instanceof Error ? error.message : String(error)}
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  if (data.var_95_21d == null || data.var_99_21d == null) {
    const obs = nObs21d ?? data.serie_retornos.length;
    const serieCurta = obs > 0 && obs < 100;
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground space-y-2">
        {semMetricas ? (
          <p>
            Fundo ainda não processado em <code className="text-xs">betas_por_cnpj</code>. Execute{" "}
            <code className="text-xs">atualizar-betas-por-cnpj.py</code> para habilitar a análise.
          </p>
        ) : serieCurta ? (
          <p>
            Série de cotas insuficiente para VaR Histórico 95%:{" "}
            <span className="font-mono">{obs}</span> janelas de 21d (mínimo 100). Fundos novos via
            XML acumulam histórico conforme os arquivos diários são importados.
          </p>
        ) : (
          <p>
            Fundo sem métricas de VaR calculadas. Execute{" "}
            <code className="text-xs">atualizar-betas-por-cnpj.py</code> para habilitar a análise
            de distribuição.
          </p>
        )}
      </div>
    );
  }

  return (
    <VarDistributionCharts
      cnpj={data.cnpj}
      nome={data.nome ?? nome}
      retornos={data.serie_retornos}
      var95={data.var_95_21d}
      var99={data.var_99_21d}
      cvar95={data.cvar_95_21d ?? data.var_95_21d}
      benchmark={data.serie_benchmark ?? undefined}
      bvar95={data.bvar_95 ?? undefined}
      var95McT={data.var_95_mc_t}
      var95Asm={data.var_95_asm}
      var99Asm={data.var_99_asm}
      cvar95Asm={data.cvar_95_asm}
      dfAsm={data.df_asm}
      ncAsm={data.nc_asm}
      skewnessRet={data.skewness_ret}
      kurtosisRet={data.kurtosis_ret}
      qualidadeAjusteAsm={data.qualidade_ajuste_asm}
      onRefresh={() => refetch()}
      isRefreshing={isFetching}
    />
  );
}
