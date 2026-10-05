import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { AuthorizedRoute } from "@/components/ProtectedRoute";
import { EnquadramentoList } from "@/components/EnquadramentoList";
import CarteiraDetalhes from "./pages/CarteiraDetalhes";
import Dashboard from "./pages/Dashboard";
import ImportXml from "./pages/ImportXml";
import Ativos from "./pages/Ativos";
import Regras from "./pages/Regras";
import RegrasRelacionais from "./pages/RegrasRelacionais";
import GruposEconomicos from "./pages/GruposEconomicos";
import Liquidez from "./pages/Liquidez";
import LiquidezConsolidado from "./pages/liquidez/LiquidezConsolidado";
import LiquidezMonitoramentoFundo from "./pages/liquidez/LiquidezMonitoramentoFundo";
import LiquidezDetalhesFundo from "./pages/liquidez/LiquidezDetalhesFundo";
import LiquidezPassivoFundos from "./pages/liquidez/LiquidezPassivoFundos";
import LiquidezResgatesSolicitados from "./pages/liquidez/LiquidezResgatesSolicitados";
import LiquidezRelatorios from "./pages/liquidez/LiquidezRelatorios";
import LiquidezMensalArtefato from "./pages/liquidez/LiquidezMensalArtefato";
import LiquidezVisaoGeral from "./pages/liquidez/LiquidezVisaoGeral";
import EnquadramentoRelatorios from "./pages/enquadramento/EnquadramentoRelatorios";
import LiquidezDescasamentoOperacional from "./pages/liquidez/LiquidezDescasamentoOperacional";
import CreditoMatriz from "./pages/credito/CreditoMatriz";
import CreditoRollRate from "./pages/credito/CreditoRollRate";
import CreditoElegibilidade from "./pages/credito/CreditoElegibilidade";
import CadastroPartes from "./pages/credito/CadastroPartes";
import CreditoEstoque from "./pages/credito/CreditoEstoque";
import ControleCotasRentabilidade from "./pages/controle-cotas/ControleCotasRentabilidade";
import ControleCotasRentabilidadeDetalhe from "./pages/controle-cotas/ControleCotasRentabilidadeDetalhe";
import EnviarRelatorioRentabilidade from "./pages/controle-cotas/EnviarRelatorioRentabilidade";
import RiscoMercado from "./pages/risco-mercado/RiscoMercado";
import GestoresMonitorados from "./pages/configuracoes/GestoresMonitorados";
import NotFound from "./pages/NotFound";

function RedirectCarteira() {
  const { cnpj } = useParams();
  return <Navigate to={`/enquadramento/carteira/${cnpj}`} replace />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>
            <PermissionsProvider>
              <Routes>
                <Route path="/" element={<Navigate to="/liquidez/monitoramento-fundo" replace />} />

                <Route path="/enquadramento" element={<AuthorizedRoute><Navigate to="/enquadramento/dashboard" replace /></AuthorizedRoute>} />
                <Route path="/enquadramento/dashboard" element={<AuthorizedRoute><Dashboard /></AuthorizedRoute>} />
                <Route path="/enquadramento/monitoramento" element={<AuthorizedRoute><EnquadramentoList /></AuthorizedRoute>} />
                <Route path="/enquadramento/carteira/:cnpj/:date?" element={<AuthorizedRoute><CarteiraDetalhes /></AuthorizedRoute>} />
                <Route path="/enquadramento/importar" element={<AuthorizedRoute><ImportXml /></AuthorizedRoute>} />
                <Route path="/enquadramento/ativos" element={<AuthorizedRoute><Ativos /></AuthorizedRoute>} />
                <Route path="/enquadramento/regras" element={<AuthorizedRoute><Regras /></AuthorizedRoute>} />
                <Route path="/enquadramento/regras-relacionais" element={<AuthorizedRoute><RegrasRelacionais /></AuthorizedRoute>} />
                <Route path="/enquadramento/grupos-economicos" element={<AuthorizedRoute><GruposEconomicos /></AuthorizedRoute>} />
                <Route path="/enquadramento/relatorios" element={<AuthorizedRoute><EnquadramentoRelatorios /></AuthorizedRoute>} />

                <Route path="/liquidez" element={<AuthorizedRoute><Navigate to="/liquidez/visao-geral" replace /></AuthorizedRoute>} />
                <Route path="/liquidez/visao-geral" element={<AuthorizedRoute><LiquidezVisaoGeral /></AuthorizedRoute>} />
                <Route path="/liquidez/matriz-anbima" element={<AuthorizedRoute><Liquidez /></AuthorizedRoute>} />
                <Route path="/liquidez/consolidado" element={<AuthorizedRoute><LiquidezConsolidado /></AuthorizedRoute>} />
                <Route path="/liquidez/importar" element={<Navigate to="/dados/importar" replace />} />
                <Route path="/liquidez/ativos" element={<Navigate to="/enquadramento/ativos" replace />} />
                <Route path="/liquidez/monitoramento-fundo" element={<AuthorizedRoute><LiquidezMonitoramentoFundo /></AuthorizedRoute>} />
                <Route path="/liquidez/monitoramento-fundo/:cnpj/:date" element={<AuthorizedRoute><LiquidezDetalhesFundo /></AuthorizedRoute>} />
                <Route path="/liquidez/passivo-fundos" element={<AuthorizedRoute><LiquidezPassivoFundos /></AuthorizedRoute>} />
                <Route path="/liquidez/resgates-solicitados" element={<AuthorizedRoute><LiquidezResgatesSolicitados /></AuthorizedRoute>} />
                <Route path="/liquidez/descasamento-operacional" element={<AuthorizedRoute><LiquidezDescasamentoOperacional /></AuthorizedRoute>} />
                <Route path="/liquidez/relatorios" element={<AuthorizedRoute><LiquidezRelatorios /></AuthorizedRoute>} />
                <Route path="/liquidez/mensal" element={<AuthorizedRoute><LiquidezMensalArtefato /></AuthorizedRoute>} />

                <Route path="/dados/importar" element={<AuthorizedRoute><ImportXml /></AuthorizedRoute>} />
                <Route path="/importar" element={<Navigate to="/dados/importar" replace />} />

                <Route path="/credito" element={<AuthorizedRoute><Navigate to="/credito/matriz" replace /></AuthorizedRoute>} />
                <Route path="/credito/matriz" element={<AuthorizedRoute><CreditoMatriz /></AuthorizedRoute>} />
                <Route path="/credito/dashboard" element={<Navigate to="/credito/matriz" replace />} />
                <Route path="/credito/monitoramento" element={<Navigate to="/credito/matriz" replace />} />
                <Route path="/credito/consolidado" element={<Navigate to="/credito/matriz" replace />} />
                <Route path="/credito/safras" element={<Navigate to="/credito/matriz" replace />} />
                <Route path="/credito/rollrate" element={<AuthorizedRoute><CreditoRollRate /></AuthorizedRoute>} />
                <Route path="/credito/elegibilidade" element={<AuthorizedRoute><CreditoElegibilidade /></AuthorizedRoute>} />
                <Route path="/credito/cadastro-partes" element={<AuthorizedRoute><CadastroPartes /></AuthorizedRoute>} />
                <Route path="/credito/importar" element={<Navigate to="/dados/importar" replace />} />
                <Route path="/credito/estoque" element={<AuthorizedRoute><CreditoEstoque /></AuthorizedRoute>} />

                <Route path="/rentabilidade" element={<AuthorizedRoute><ControleCotasRentabilidade /></AuthorizedRoute>} />
                <Route path="/rentabilidade/:cnpj" element={<AuthorizedRoute><ControleCotasRentabilidadeDetalhe /></AuthorizedRoute>} />
                <Route path="/rentabilidade/enviar-relatorio" element={<AuthorizedRoute><EnviarRelatorioRentabilidade /></AuthorizedRoute>} />
                <Route path="/controle-cotas/rentabilidade" element={<Navigate to="/rentabilidade" replace />} />
                <Route path="/controle-cotas/rentabilidade/:cnpj" element={<RedirectRentabilidadeDetalhe />} />
                <Route path="/controle-cotas/enviar-relatorio" element={<Navigate to="/rentabilidade/enviar-relatorio" replace />} />

                <Route path="/risco-mercado" element={<AuthorizedRoute><RiscoMercado /></AuthorizedRoute>} />

                <Route path="/configuracoes/gestores" element={<AuthorizedRoute><GestoresMonitorados /></AuthorizedRoute>} />
                <Route path="/dados/gestores-monitorados" element={<Navigate to="/configuracoes/gestores" replace />} />
                <Route path="/configuracoes" element={<Navigate to="/configuracoes/gestores" replace />} />

                <Route path="/dashboard" element={<Navigate to="/enquadramento/dashboard" replace />} />
                <Route path="/enquadramentos" element={<Navigate to="/enquadramento/monitoramento" replace />} />
                <Route path="/carteira/:cnpj" element={<RedirectCarteira />} />
                <Route path="/ativos" element={<Navigate to="/enquadramento/ativos" replace />} />
                <Route path="/regras" element={<Navigate to="/enquadramento/regras" replace />} />
                <Route path="/regras-relacionais" element={<Navigate to="/enquadramento/regras-relacionais" replace />} />

                <Route path="*" element={<NotFound />} />
              </Routes>
            </PermissionsProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function RedirectRentabilidadeDetalhe() {
  const { cnpj } = useParams();
  return <Navigate to={`/rentabilidade/${cnpj}`} replace />;
}
