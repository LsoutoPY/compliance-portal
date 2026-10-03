import { Layout } from "@/components/Layout";
import { RelatorioPageHeader } from "@/components/relatorios/RelatorioPageHeader";
import { RiscoMercadoRelatorioPanel } from "@/components/relatorios/RiscoMercadoRelatorioPanel";
import { RiscoOcorrenciasPanel } from "@/components/relatorios/RiscoOcorrenciasPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldAlert } from "lucide-react";

export default function RiscoMercadoRelatorios() {
  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <RelatorioPageHeader
          icon={ShieldAlert}
          title="Relatórios de Risco de Mercado"
          subtitle="Relatório diário, mensal e para Comitê de Risco. VaR, stress e consumo de limites por fundo gerido — dados via posição XML e betas_por_cnpj."
        />
        <Tabs defaultValue="operacional" className="w-full">
          <TabsList className="grid w-full max-w-lg grid-cols-2">
            <TabsTrigger value="operacional">Visão operacional</TabsTrigger>
            <TabsTrigger value="ocorrencias">Ocorrências & planos</TabsTrigger>
          </TabsList>
          <TabsContent value="operacional" className="mt-5">
            <RiscoMercadoRelatorioPanel embedded />
          </TabsContent>
          <TabsContent value="ocorrencias" className="mt-5">
            <RiscoOcorrenciasPanel modulos={["mercado"]} />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
