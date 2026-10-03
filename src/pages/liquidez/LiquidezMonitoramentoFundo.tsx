import { Layout } from "@/components/Layout";
import { LiquidezMonitoramentoList } from "@/components/liquidez/LiquidezMonitoramentoList";

export default function LiquidezMonitoramentoFundo() {
  return (
    <Layout>
      <div className="w-full max-w-[1600px] mx-auto">
        <LiquidezMonitoramentoList />
      </div>
    </Layout>
  );
}
