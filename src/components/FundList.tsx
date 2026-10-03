import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertCircle, Search, Calendar, ArrowRight, ChevronDown, ChevronRight, ClipboardCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RulesList } from "@/components/RulesSheet";

export function FundList() {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedFund, setExpandedFund] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data: funds, isLoading, error } = useQuery({
    queryKey: ["funds"],
    queryFn: async () => {
      // 1. Get the latest position date to ensure we list currently active funds
      const { data: latestDateData, error: dateError } = await supabase
        .from("posicao_carteira")
        .select("fundo_dtposicao")
        .order("fundo_dtposicao", { ascending: false })
        .limit(1);

      if (dateError) {
        console.error("Erro ao buscar data mais recente:", dateError);
        throw dateError;
      }
      
      if (!latestDateData || latestDateData.length === 0) return [];

      const latestDate = latestDateData[0].fundo_dtposicao;

      // 2. Fetch all funds for that date
      const { data, error } = await supabase
        .from("posicao_carteira")
        .select("fundo_nome, fundo_cnpj, fundo_dtposicao, fundo_patliq")
        .eq("fundo_dtposicao", latestDate);

      if (error) {
        console.error("Erro ao buscar fundos:", error);
        throw error;
      }

      // 3. Deduplicate funds (since there are many rows per fund)
      const uniqueFundsMap = new Map();
      
      data.forEach((item) => {
        if (item.fundo_cnpj && !uniqueFundsMap.has(item.fundo_cnpj)) {
          uniqueFundsMap.set(item.fundo_cnpj, {
            fundo_nome: item.fundo_nome,
            fundo_cnpj: item.fundo_cnpj,
            fundo_dtposicao: item.fundo_dtposicao,
            fundo_patliq: item.fundo_patliq // This might be per row, but typically is same for all rows of same fund/date, or we take one
          });
        }
      });

      return Array.from(uniqueFundsMap.values());
    },
  });

  const filteredFunds = funds?.filter((fund) =>
    fund.fundo_nome?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    fund.fundo_cnpj.includes(searchTerm)
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-full max-w-sm bg-muted animate-pulse rounded-md" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="h-32">
              <CardHeader>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Erro</AlertTitle>
        <AlertDescription>
          Não foi possível carregar a lista de fundos. {error instanceof Error ? error.message : "Erro desconhecido"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Fundos de Investimento</h2>
          <p className="text-muted-foreground">
            Lista de fundos ativos em {funds?.[0]?.fundo_dtposicao ? 
              new Date(funds[0].fundo_dtposicao.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).toLocaleDateString('pt-BR') 
              : 'Data desconhecida'}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou CNPJ..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={() => navigate("/enquadramento/monitoramento")} variant="outline" className="gap-2">
          Enquadramentos <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredFunds?.map((fund) => (
          <Card key={fund.fundo_cnpj} className="hover:shadow-md transition-shadow">
            <CardHeader className="space-y-1">
              <CardTitle className="text-lg leading-snug">
                {fund.fundo_nome || "Fundo sem nome"}
              </CardTitle>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary" className="font-normal">
                  CNPJ: {fund.fundo_cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>Posição: {fund.fundo_dtposicao?.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')}</span>
              </div>
              {fund.fundo_patliq && (
                 <div className="text-sm font-medium">
                   PL: {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(fund.fundo_patliq)}
                 </div>
              )}
              <Collapsible
                open={expandedFund === fund.fundo_cnpj}
                onOpenChange={() => setExpandedFund(expandedFund === fund.fundo_cnpj ? null : fund.fundo_cnpj)}
              >
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between gap-2 h-8 text-xs">
                    <div className="flex items-center gap-2">
                      <ClipboardCheck className="h-3.5 w-3.5" />
                      Regras de Enquadramento
                    </div>
                    {expandedFund === fund.fundo_cnpj ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="border-t pt-3">
                    <RulesList
                      fundoCnpj={fund.fundo_cnpj}
                      fundoDtposicao={fund.fundo_dtposicao}
                      maxHeight="300px"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
        ))}
        {filteredFunds?.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            Nenhum fundo encontrado com os critérios de busca.
          </div>
        )}
      </div>
    </div>
  );
}
