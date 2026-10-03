import { Layout } from "@/components/Layout";
import { RelatorioPageHeader } from "@/components/relatorios/RelatorioPageHeader";
import { EnquadramentoRelatorioPanel } from "@/components/relatorios/EnquadramentoRelatorioPanel";
import { RiscoOcorrenciasPanel } from "@/components/relatorios/RiscoOcorrenciasPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";

export default function EnquadramentoRelatorios() {
  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-6">
        <RelatorioPageHeader
          icon={ShieldCheck}
          title="Relatórios de Enquadramento"
          subtitle="Relatório diário, mensal e para Comitê de Risco. Consolida o status de compliance de todos os fundos — execute Recalcular para atualizar as verificações de regras."
        />
        <Tabs defaultValue="operacional" className="w-full">
          <TabsList className="grid w-full max-w-lg grid-cols-2">
            <TabsTrigger value="operacional">Visão operacional</TabsTrigger>
            <TabsTrigger value="ocorrencias">Ocorrências & planos</TabsTrigger>
          </TabsList>
          <TabsContent value="operacional" className="mt-5">
            <EnquadramentoRelatorioPanel embedded />
          </TabsContent>
          <TabsContent value="ocorrencias" className="mt-5">
            <RiscoOcorrenciasPanel modulos={["enquadramento", "concentracao"]} />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
