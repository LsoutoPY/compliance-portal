// VarDistributionCharts.tsx
// Painel analítico de distribuição de retornos para um CNPJ/fundo.
//
// Abas:
//   Histórico       — histograma + estatísticas + série temporal vs VaR/CVaR
//   Paramétrico     — histograma + Normal ajustada + Q-Q plot + série temporal
//   Monte Carlo     — fan chart de simulações (Normal/t-Student) + distribuição simulada
//   VaR Assim       — piloto NCT (skew negativa) + comparativo com outros métodos
//   B-VaR           — distribuição do excesso de retorno vs benchmark
//
// Toda a matemática é implementada em TypeScript puro (sem bibliotecas
// estatísticas). Valores de retorno/VaR em decimal (negativo = perda).

import { useState, useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Cell,
} from "recharts";
import type { RetornoPoint, VarDistributionChartsProps } from "@/types/risco-mercado";

type Aba = "historico" | "parametrico" | "mc" | "assimetrico" | "bvar";

// ─── Paleta (hex fixo — Recharts não resolve CSS vars de tema) ───────────────
const C = {
  retorno:   "#3B82F6",   // azul
  var95:     "#EF4444",   // vermelho
  var99:     "#F97316",   // laranja
  cvar:      "#EAB308",   // âmbar
  normal:    "#3B82F6",   // curva normal
  mc:        "#93C5FD",   // azul claro para bandas MC
  benchmark: "#10B981",   // verde
  bvar:      "#F59E0B",   // âmbar para B-VaR
  bar:       "#94A3B8",   // barras neutras
  barExc:    "#FCA5A5",   // barras de exceção (cauda 99%)
  barAlerta: "#FCD34D",   // barras entre VaR 99% e VaR 95%
  ok:        "#10B981",
  asm:       "#8B5CF6",   // violeta — VaR assimétrico piloto
  tick:      "#9CA3AF",   // eixos/grid — legível em light e dark
};

const TICK = { fontSize: 10, fill: C.tick };

const MC_DEFAULT_STEPS = 30;
const MC_DEFAULT_PATHS = 5000;
const MC_STEPS_MIN = 5;
const MC_STEPS_MAX = 252;
const MC_PATHS_MIN = 50;
const MC_PATHS_MAX = 10000;

function clampMcInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

// ─── Utilitários estatísticos ────────────────────────────────────────────────

interface HistBin {
  x: number;
  count: number;
  width: number;
}

function buildHistogram(data: number[], bins = 40): HistBin[] {
  if (data.length === 0) return [];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const width = (max - min) / bins || 1e-9;
  const counts = Array<number>(bins).fill(0);
  data.forEach((v) => {
    const i = Math.min(Math.floor((v - min) / width), bins - 1);
    counts[i]++;
  });
  return counts.map((count, i) => ({
    x: min + (i + 0.5) * width,
    count,
    width,
  }));
}

function normalPdf(x: number, mu: number, sigma: number): number {
  return (
    (1 / (sigma * Math.sqrt(2 * Math.PI))) *
    Math.exp(-0.5 * ((x - mu) / sigma) ** 2)
  );
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** VaR como perda: nunca positivo (alinhado ao Python offline). */
function varComoPerda(v: number): number {
  return Math.min(v, 0);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr: number[], mu?: number): number {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// Amostra Normal padrão via Box-Muller (1 - random evita log(0))
function sampleNormal(): number {
  return (
    Math.sqrt(-2 * Math.log(1 - Math.random())) *
    Math.cos(2 * Math.PI * Math.random())
  );
}

// Amostra t-Student padronizada (variância 1): t = Z / sqrt(Chi²(df)/df),
// reescalada por sqrt((df-2)/df) para variância unitária.
function sampleT(df: number): number {
  let chi2 = 0;
  for (let i = 0; i < df; i++) {
    const z = sampleNormal();
    chi2 += z * z;
  }
  const t = sampleNormal() / Math.sqrt(chi2 / df);
  return t * Math.sqrt((df - 2) / df);
}

// Estima graus de liberdade pela curtose em excesso: k = 6/(df-4)
function estimateDf(data: number[]): number {
  const mu = mean(data);
  const s = std(data, mu);
  if (!s || data.length < 8) return 5;
  const m4 = mean(data.map((v) => ((v - mu) / s) ** 4));
  const kExcess = m4 - 3;
  if (kExcess <= 0.2) return 30; // próximo da Normal
  return Math.round(Math.min(30, Math.max(3, 4 + 6 / kExcess)));
}

// Simula caminhos de Monte Carlo (retorno acumulado por passo)
function simulateMC(
  mu: number,
  sigma: number,
  steps = 30,
  paths = 200,
  dist: "normal" | "t" = "normal",
  df = 5,
): number[][] {
  return Array.from({ length: paths }, () => {
    let cum = 0;
    return Array.from({ length: steps }, () => {
      const z = dist === "t" ? sampleT(df) : sampleNormal();
      cum += mu + sigma * z;
      return cum;
    });
  });
}

// Q-Q plot: quantis empíricos padronizados vs quantis teóricos da Normal.
// Inversa da Normal via aproximação de Beasley-Springer-Moro (Abramowitz-Stegun 26.2.23).
function qqData(data: number[]): { theoretical: number; empirical: number }[] {
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const mu = mean(sorted);
  const s = std(sorted, mu) || 1e-9;
  return sorted.map((v, i) => {
    const p = (i + 0.5) / n;
    const t =
      p < 0.5 ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p));
    const theoretical =
      (p < 0.5 ? -1 : 1) *
      (t -
        (2.515517 + 0.802853 * t + 0.010328 * t * t) /
          (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
    return { theoretical, empirical: (v - mu) / s };
  });
}

// ReferenceLine vertical em eixo de categorias: usa o centro de bin mais próximo
function nearestBinX(hist: HistBin[], v: number): number | null {
  if (hist.length === 0) return null;
  let best = hist[0].x;
  let bestDist = Math.abs(hist[0].x - v);
  for (const b of hist) {
    const d = Math.abs(b.x - v);
    if (d < bestDist) {
      best = b.x;
      bestDist = d;
    }
  }
  return best;
}

// ─── Formatadores ────────────────────────────────────────────────────────────

const fmtPct = (v: number) => `${(v * 100).toFixed(3)}%`;
const fmtPct2 = (v: number) => `${(v * 100).toFixed(2)}%`;
const fmtDate = (d: string) => {
  const dt = new Date(`${d}T12:00:00`);
  return dt.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
};

// ─── Tooltip customizado ─────────────────────────────────────────────────────

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur-sm">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload
        .filter((p) => p.value != null)
        .map((p, i) => (
          <p key={`${p.name}-${i}`} style={{ color: p.color }} className="font-mono">
            {p.name}: {typeof p.value === "number" ? fmtPct(p.value) : p.value}
          </p>
        ))}
    </div>
  );
}

// ─── KPI cards ───────────────────────────────────────────────────────────────

function KpiRow({
  var95,
  var99,
  cvar95,
  retornos,
}: {
  var95: number;
  var99: number;
  cvar95: number;
  retornos: number[];
}) {
  const n = retornos.length;
  const exc95 = retornos.filter((r) => r < var95).length;
  const exc99 = retornos.filter((r) => r < var99).length;

  const items = [
    { label: "VaR 95%", value: fmtPct(var95), color: C.var95 },
    { label: "VaR 99%", value: fmtPct(var99), color: C.var99 },
    { label: "CVaR 95%", value: fmtPct(cvar95), color: C.cvar },
    {
      label: "Exceções 95%",
      value: `${exc95} / ${n} (${((exc95 / n) * 100).toFixed(1)}%)`,
      color: exc95 / n > 0.07 ? C.var95 : C.ok,
    },
    {
      label: "Exceções 99%",
      value: `${exc99} / ${n} (${((exc99 / n) * 100).toFixed(1)}%)`,
      color: exc99 / n > 0.015 ? C.var95 : C.ok,
    },
  ];

  return (
    <div className="flex flex-wrap gap-3 mb-5">
      {items.map((it) => (
        <div
          key={it.label}
          className="flex-1 min-w-[120px] rounded-lg border border-border bg-muted/30 px-4 py-3"
        >
          <div className="text-[11px] text-muted-foreground mb-1">{it.label}</div>
          <div className="text-base font-semibold font-mono" style={{ color: it.color }}>
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Aba Histórico ───────────────────────────────────────────────────────────

function AbaHistorico({
  retornos,
  var95,
  var99,
  cvar95,
}: {
  retornos: RetornoPoint[];
  var95: number;
  var99: number;
  cvar95: number;
}) {
  const rets = useMemo(() => retornos.map((r) => r.ret), [retornos]);
  const hist = useMemo(() => buildHistogram(rets, 40), [rets]);

  const q1 = percentile(rets, 25);
  const q3 = percentile(rets, 75);
  const med = percentile(rets, 50);

  const refVar95 = nearestBinX(hist, var95);
  const refVar99 = nearestBinX(hist, var99);

  const serie = useMemo(
    () =>
      retornos.map((r) => ({
        data: r.data,
        ret: r.ret,
        exc: r.ret < var95 ? r.ret : null,
        label: fmtDate(r.data),
      })),
    [retornos, var95],
  );

  return (
    <div className="space-y-6">
      {/* Histograma */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Distribuição dos retornos diários
        </p>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={hist} barCategoryGap="0%">
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis dataKey="x" tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <YAxis tick={TICK} allowDecimals={false} />
            <Tooltip
              formatter={(v: number) => [v, "Freq"]}
              labelFormatter={(l) => fmtPct(Number(l))}
            />
            {refVar95 != null && (
              <ReferenceLine
                x={refVar95}
                stroke={C.var95}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{ value: "VaR 95%", position: "top", fontSize: 10, fill: C.var95 }}
              />
            )}
            {refVar99 != null && (
              <ReferenceLine
                x={refVar99}
                stroke={C.var99}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{ value: "VaR 99%", position: "top", fontSize: 10, fill: C.var99 }}
              />
            )}
            <Bar dataKey="count" fill={C.bar} radius={[1, 1, 0, 0]}>
              {hist.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.x < var99 ? C.barExc : entry.x < var95 ? C.barAlerta : C.bar}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Estatísticas descritivas */}
      <div className="grid grid-cols-5 gap-2 text-center">
        {(
          [
            ["Mín", Math.min(...rets)],
            ["Q1", q1],
            ["Mediana", med],
            ["Q3", q3],
            ["Máx", Math.max(...rets)],
          ] as Array<[string, number]>
        ).map(([label, val]) => (
          <div key={label} className="rounded bg-muted/30 px-2 py-2">
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className="text-xs font-mono font-medium text-foreground">{fmtPct(val)}</div>
          </div>
        ))}
      </div>

      {/* Série temporal */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Série temporal vs limite VaR
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={serie}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis
              dataKey="label"
              tick={TICK}
              interval={Math.max(0, Math.floor(serie.length / 8))}
            />
            <YAxis tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={var95} stroke={C.var95} strokeDasharray="5 4" strokeWidth={1.5} />
            <ReferenceLine y={var99} stroke={C.var99} strokeDasharray="5 4" strokeWidth={1.5} />
            <ReferenceLine y={cvar95} stroke={C.cvar} strokeDasharray="5 4" strokeWidth={1.5} />
            <Line
              type="linear"
              dataKey="ret"
              stroke={C.retorno}
              strokeWidth={1}
              dot={false}
              name="Retorno diário"
            />
            <Scatter dataKey="exc" fill={C.var95} name="Exceção" />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="flex gap-4 text-[10px] text-muted-foreground mt-1 justify-end flex-wrap">
          <span>
            <span style={{ color: C.var95 }}>——</span> VaR 95%: {fmtPct(var95)}
          </span>
          <span>
            <span style={{ color: C.var99 }}>——</span> VaR 99%: {fmtPct(var99)}
          </span>
          <span>
            <span style={{ color: C.cvar }}>——</span> CVaR: {fmtPct(cvar95)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Aba Paramétrico ─────────────────────────────────────────────────────────

function AbaParametrico({ retornos }: { retornos: RetornoPoint[] }) {
  const rets = useMemo(() => retornos.map((r) => r.ret), [retornos]);
  const mu = mean(rets);
  const sigma = std(rets, mu);

  // VaR paramétrico Normal (1d)
  const varParam95 = varComoPerda(mu - 1.6449 * sigma);
  const varParam99 = varComoPerda(mu - 2.3263 * sigma);

  // Histograma + curva Normal mesclados no mesmo dataset
  const histNormal = useMemo(() => {
    const hist = buildHistogram(rets, 40);
    const scale = rets.length * (hist[0]?.width ?? 1);
    return hist.map((b) => ({ ...b, normal: normalPdf(b.x, mu, sigma) * scale }));
  }, [rets, mu, sigma]);

  const refVar95 = nearestBinX(histNormal, varParam95);
  const refVar99 = nearestBinX(histNormal, varParam99);

  // Q-Q plot
  const qq = useMemo(() => qqData(rets), [rets]);
  const qqMin = Math.min(...qq.map((p) => p.theoretical));
  const qqMax = Math.max(...qq.map((p) => p.theoretical));
  const qqLine = [
    { theoretical: qqMin, line: qqMin },
    { theoretical: qqMax, line: qqMax },
  ];

  const serie = useMemo(
    () => retornos.map((r) => ({ ...r, label: fmtDate(r.data) })),
    [retornos],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Histograma + Normal ajustada */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Distribuição: real vs Normal ajustada
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={histNormal}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
              <XAxis dataKey="x" tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
              <YAxis tick={TICK} allowDecimals={false} />
              <Tooltip
                formatter={(v: number, name: string) => [
                  name === "Normal" ? v.toFixed(1) : v,
                  name,
                ]}
                labelFormatter={(l) => fmtPct(Number(l))}
              />
              {refVar95 != null && (
                <ReferenceLine
                  x={refVar95}
                  stroke={C.var95}
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{ value: "VaR 95%", position: "top", fontSize: 9, fill: C.var95 }}
                />
              )}
              {refVar99 != null && (
                <ReferenceLine
                  x={refVar99}
                  stroke={C.var99}
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{ value: "VaR 99%", position: "top", fontSize: 9, fill: C.var99 }}
                />
              )}
              <Bar dataKey="count" fill={C.bar} fillOpacity={0.6} radius={[1, 1, 0, 0]} name="Freq" />
              <Line
                type="monotone"
                dataKey="normal"
                stroke={C.normal}
                strokeWidth={2}
                dot={false}
                name="Normal"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-1 text-[10px] text-muted-foreground">
            μ = {fmtPct(mu)} · σ = {fmtPct(sigma)} ·{" "}
            <span style={{ color: C.var95 }}>VaR Param = {fmtPct(varParam95)}</span>
          </div>
        </div>

        {/* Q-Q plot */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Q-Q plot (empírico vs Normal)
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
              <XAxis
                type="number"
                dataKey="theoretical"
                name="Teórico"
                tick={TICK}
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <YAxis
                type="number"
                tick={TICK}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(v: number) => [v.toFixed(3), ""]}
                labelFormatter={(l) => `Teórico: ${Number(l).toFixed(3)}`}
              />
              <Line
                data={qqLine}
                type="linear"
                dataKey="line"
                stroke={C.var95}
                strokeWidth={1.5}
                dot={false}
                legendType="none"
                name="y = x"
              />
              <Scatter data={qq} dataKey="empirical" fill={C.retorno} fillOpacity={0.6} name="Quantil" />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[10px] text-muted-foreground mt-1">
            Pontos próximos à linha vermelha indicam aderência à Normal. Desvios nas caudas revelam fat tails.
          </p>
        </div>
      </div>

      {/* Série temporal vs VaR paramétrico */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Histórico vs limite VaR paramétrico
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={serie}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis
              dataKey="label"
              tick={TICK}
              interval={Math.max(0, Math.floor(serie.length / 8))}
            />
            <YAxis tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={varParam95} stroke={C.var95} strokeDasharray="5 4" strokeWidth={1.5} />
            <ReferenceLine y={varParam99} stroke={C.var99} strokeDasharray="5 4" strokeWidth={1.5} />
            <Line
              type="linear"
              dataKey="ret"
              stroke={C.retorno}
              strokeWidth={1}
              dot={false}
              name="Retorno diário"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="flex gap-4 text-[10px] text-muted-foreground mt-1 justify-end">
          <span>
            <span style={{ color: C.var95 }}>——</span> VaR 95%: {fmtPct(varParam95)}
          </span>
          <span>
            <span style={{ color: C.var99 }}>——</span> VaR 99%: {fmtPct(varParam99)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Aba Monte Carlo ─────────────────────────────────────────────────────────

function AbaMonteCarlo({
  retornos,
}: {
  retornos: RetornoPoint[];
}) {
  const [distType, setDistType] = useState<"normal" | "t">("normal");
  const [stepsInput, setStepsInput] = useState(String(MC_DEFAULT_STEPS));
  const [pathsInput, setPathsInput] = useState(String(MC_DEFAULT_PATHS));
  const [mcSeed, setMcSeed] = useState(0);

  const steps = clampMcInt(Number(stepsInput), MC_STEPS_MIN, MC_STEPS_MAX, MC_DEFAULT_STEPS);
  const paths = clampMcInt(Number(pathsInput), MC_PATHS_MIN, MC_PATHS_MAX, MC_DEFAULT_PATHS);

  const rets = useMemo(() => retornos.map((r) => r.ret), [retornos]);
  const mu = mean(rets);
  const sigma = std(rets, mu);
  const df = useMemo(() => estimateDf(rets), [rets]);

  const pathsData = useMemo(
    () => simulateMC(mu, sigma, steps, paths, distType, df),
    [mu, sigma, steps, paths, distType, df, mcSeed],
  );

  const fanData = useMemo(
    () =>
      Array.from({ length: steps }, (_, step) => {
        const vals = pathsData.map((p) => p[step]);
        return {
          step: step + 1,
          p1: percentile(vals, 1),
          p5: percentile(vals, 5),
          p25: percentile(vals, 25),
          p50: percentile(vals, 50),
          p75: percentile(vals, 75),
          p95: percentile(vals, 95),
        };
      }),
    [pathsData, steps],
  );

  const finalRets = useMemo(
    () => pathsData.map((p) => p[steps - 1]),
    [pathsData, steps],
  );
  const mcVar95 = useMemo(() => varComoPerda(percentile(finalRets, 5)), [finalRets]);
  const mcVar99 = useMemo(() => varComoPerda(percentile(finalRets, 1)), [finalRets]);
  const histMC = useMemo(() => buildHistogram(finalRets, 35), [finalRets]);
  const refMcVar95 = nearestBinX(histMC, mcVar95);
  const refMcVar99 = nearestBinX(histMC, mcVar99);

  const rerunMc = () => setMcSeed((s) => s + 1);

  return (
    <div className="space-y-6">
      {/* Toggle Normal / t-Student + parâmetros MC */}
      <div className="flex items-center gap-3 flex-wrap">
        {(["normal", "t"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setDistType(t)}
            className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-colors ${
              distType === t
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full border-2 ${
                distType === t ? "bg-white border-white" : "border-muted-foreground"
              }`}
            />
            {t === "normal" ? "Normal" : `t-Student (df=${df})`}
          </button>
        ))}
        <span className="text-[11px] text-muted-foreground">
          {distType === "t"
            ? "Caudas pesadas — mais conservador"
            : "Distribuição simétrica padrão"}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="mc-steps" className="text-[11px] text-muted-foreground">
            Passos
          </Label>
          <Input
            id="mc-steps"
            type="number"
            min={MC_STEPS_MIN}
            max={MC_STEPS_MAX}
            value={stepsInput}
            onChange={(e) => setStepsInput(e.target.value)}
            onBlur={() => setStepsInput(String(steps))}
            className="h-8 w-24 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mc-paths" className="text-[11px] text-muted-foreground">
            Simulações
          </Label>
          <Input
            id="mc-paths"
            type="number"
            min={MC_PATHS_MIN}
            max={MC_PATHS_MAX}
            value={pathsInput}
            onChange={(e) => setPathsInput(e.target.value)}
            onBlur={() => setPathsInput(String(paths))}
            className="h-8 w-28 text-xs font-mono"
          />
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={rerunMc}>
          <RefreshCw className="h-3.5 w-3.5" />
          Recalcular
        </Button>
        <span className="text-[10px] text-muted-foreground pb-1">
          Passos: {MC_STEPS_MIN}–{MC_STEPS_MAX} · Simulações: {MC_PATHS_MIN}–{MC_PATHS_MAX.toLocaleString("pt-BR")}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fan chart */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Evolução das simulações ({steps} passos)
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={fanData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
              <XAxis dataKey="step" tick={TICK} />
              <YAxis tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="p95" stroke={C.mc} strokeWidth={1} strokeDasharray="2 2" dot={false} name="P95" />
              <Line type="monotone" dataKey="p75" stroke={C.mc} strokeWidth={1} strokeDasharray="3 2" dot={false} name="P75" />
              <Line type="monotone" dataKey="p50" stroke={C.retorno} strokeWidth={2} dot={false} name="Mediana" />
              <Line type="monotone" dataKey="p25" stroke={C.mc} strokeWidth={1} strokeDasharray="3 2" dot={false} name="P25" />
              <Line type="monotone" dataKey="p5" stroke={C.var95} strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="VaR 95% (P5)" />
              <Line type="monotone" dataKey="p1" stroke={C.var99} strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="VaR 99% (P1)" />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[10px] text-muted-foreground mt-1">
            {paths.toLocaleString("pt-BR")} simulações · bandas P5/P25/P50/P75/P95
          </p>
        </div>

        {/* Distribuição dos retornos finais */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
            Distribuição dos retornos finais (passo {steps})
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={histMC} barCategoryGap="0%">
              <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
              <XAxis dataKey="x" tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
              <YAxis tick={TICK} allowDecimals={false} />
              <Tooltip
                formatter={(v: number) => [v, "Freq"]}
                labelFormatter={(l) => fmtPct(Number(l))}
              />
              {refMcVar95 != null && (
                <ReferenceLine
                  x={refMcVar95}
                  stroke={C.var95}
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{ value: "VaR 95%", position: "top", fontSize: 9, fill: C.var95 }}
                />
              )}
              {refMcVar99 != null && (
                <ReferenceLine
                  x={refMcVar99}
                  stroke={C.var99}
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{ value: "VaR 99%", position: "insideTopRight", fontSize: 9, fill: C.var99 }}
                />
              )}
              <Bar dataKey="count" fill={C.mc} fillOpacity={0.8} radius={[1, 1, 0, 0]} name="MC">
                {histMC.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry.x < mcVar99
                        ? C.barExc
                        : entry.x < mcVar95
                          ? C.barAlerta
                          : C.mc
                    }
                    fillOpacity={0.8}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-4 text-[10px] text-muted-foreground mt-1 justify-end flex-wrap">
            <span>
              <span style={{ color: C.var95 }}>——</span> VaR 95% (P5): {fmtPct(mcVar95)}
            </span>
            <span>
              <span style={{ color: C.var99 }}>——</span> VaR 99% (P1): {fmtPct(mcVar99)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Aba B-VaR ───────────────────────────────────────────────────────────────

function AbaBVaR({
  retornos,
  benchmark,
  bvar95,
}: {
  retornos: RetornoPoint[];
  benchmark?: RetornoPoint[];
  bvar95?: number;
}) {
  const excess = useMemo(() => {
    if (!benchmark?.length) return [];
    const bmMap = new Map(benchmark.map((b) => [b.data, b.ret]));
    return retornos
      .filter((r) => bmMap.has(r.data))
      .map((r) => ({ data: r.data, exc: r.ret - (bmMap.get(r.data) ?? 0) }));
  }, [retornos, benchmark]);

  if (!benchmark?.length || bvar95 == null) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        <p>Benchmark não configurado para este fundo.</p>
        <p className="text-xs mt-1">
          Configure o benchmark e recalcule com <code>calcular_var_completo.py</code> para
          habilitar a análise de B-VaR.
        </p>
      </div>
    );
  }

  if (excess.length < 2) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        <p>Sem datas em comum entre fundo e benchmark.</p>
      </div>
    );
  }

  const excessVals = excess.map((e) => e.exc);
  const hist = buildHistogram(excessVals, 35);
  const serie = excess.map((e) => ({ ...e, label: fmtDate(e.data) }));
  const tail = excessVals.filter((v) => v < bvar95);
  const cvarBVaR = tail.length > 0 ? mean(tail) : null;
  const excCount = tail.length;
  const refBvar = nearestBinX(hist, bvar95);
  const refZero = nearestBinX(hist, 0);

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="flex gap-3 flex-wrap">
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex-1 min-w-[120px]">
          <div className="text-[11px] text-muted-foreground mb-1">B-VaR 95%</div>
          <div className="text-base font-semibold font-mono" style={{ color: C.bvar }}>
            {fmtPct(bvar95)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex-1 min-w-[120px]">
          <div className="text-[11px] text-muted-foreground mb-1">CVaR do excesso</div>
          <div className="text-base font-semibold font-mono" style={{ color: C.var95 }}>
            {cvarBVaR != null ? fmtPct(cvarBVaR) : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex-1 min-w-[120px]">
          <div className="text-[11px] text-muted-foreground mb-1">Exceções</div>
          <div className="text-base font-semibold font-mono text-foreground">
            {excCount} / {excess.length}
          </div>
        </div>
      </div>

      {/* Histograma do excesso */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Distribuição do excesso de retorno (fundo − benchmark)
        </p>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={hist} barCategoryGap="0%">
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis dataKey="x" tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <YAxis tick={TICK} allowDecimals={false} />
            <Tooltip
              formatter={(v: number) => [v, "Freq"]}
              labelFormatter={(l) => fmtPct(Number(l))}
            />
            {refBvar != null && (
              <ReferenceLine
                x={refBvar}
                stroke={C.bvar}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{ value: "B-VaR 95%", position: "top", fontSize: 10, fill: C.bvar }}
              />
            )}
            {refZero != null && <ReferenceLine x={refZero} stroke={C.tick} strokeWidth={1} />}
            <Bar dataKey="count" radius={[1, 1, 0, 0]}>
              {hist.map((entry, i) => (
                <Cell key={i} fill={entry.x < bvar95 ? C.barAlerta : C.bar} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Série do excesso */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Excesso de retorno vs B-VaR
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={serie}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis
              dataKey="label"
              tick={TICK}
              interval={Math.max(0, Math.floor(serie.length / 8))}
            />
            <YAxis tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={bvar95} stroke={C.bvar} strokeDasharray="5 4" strokeWidth={1.5} />
            <ReferenceLine y={0} stroke={C.tick} strokeWidth={1} />
            <Line
              type="linear"
              dataKey="exc"
              stroke={C.benchmark}
              strokeWidth={1}
              dot={false}
              name="Excesso"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Aba VaR Assimétrico (piloto NCT) ────────────────────────────────────────

function AbaAssimetrico({
  var95Hist,
  var95McT,
  var95Asm,
  var99Asm,
  cvar95Asm,
  skewnessRet,
  kurtosisRet,
  dfAsm,
  ncAsm,
  qualidadeAjusteAsm,
}: {
  var95Hist: number;
  var95McT?: number | null;
  var95Asm?: number | null;
  var99Asm?: number | null;
  cvar95Asm?: number | null;
  skewnessRet?: number | null;
  kurtosisRet?: number | null;
  dfAsm?: number | null;
  ncAsm?: number | null;
  qualidadeAjusteAsm?: "bom" | "aceitavel" | "fraco" | null;
}) {
  const asmExibivel = var95Asm != null && var95Asm !== 0;

  const comparativo = useMemo(() => {
    const items: { metodo: string; valor: number; cor: string }[] = [
      { metodo: "VaR Hist 95%", valor: var95Hist, cor: C.var95 },
    ];
    if (var95McT != null) items.push({ metodo: "VaR MC(t) 95%", valor: var95McT, cor: C.retorno });
    if (asmExibivel) items.push({ metodo: "VaR Assim 95%", valor: var95Asm!, cor: C.asm });
    return items;
  }, [var95Hist, var95McT, var95Asm, asmExibivel]);

  const temDiagAsm =
    skewnessRet != null &&
    (dfAsm != null || ncAsm != null || qualidadeAjusteAsm != null || kurtosisRet != null);

  if (skewnessRet == null && var95Asm == null) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground space-y-3 max-w-lg mx-auto">
        <p>
          <strong>VaR Assimétrico</strong> sem dados em <code className="text-[11px]">betas_por_cnpj</code>.
        </p>
        <p className="text-xs text-left space-y-2">
          A migration só <em>cria</em> as colunas — não preenche valores. Ordem correta:
        </p>
        <ol className="text-xs text-left list-decimal list-inside space-y-1">
          <li>
            Migration{" "}
            <code className="text-[11px]">20260611_var_assimetrico_credito.sql</code> (já aplicada?)
          </li>
          <li>
            Rodar de novo{" "}
            <code className="text-[11px]">python scripts/atualizar-betas-por-cnpj.py</code>{" "}
            <strong>depois</strong> da migration
          </li>
          <li>
            Conferir no terminal: não pode aparecer{" "}
            <code className="text-[11px]">sem VaR assimétrico — migration</code>
          </li>
          <li>
            Validar no SQL:{" "}
            <code className="text-[11px]">SELECT skewness_ret, var_95_asm FROM betas_por_cnpj WHERE cnpj = &apos;…&apos;</code>
          </li>
        </ol>
      </div>
    );
  }

  if (skewnessRet != null && skewnessRet >= 0 && var95Asm == null) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground space-y-2">
        <p>
          Piloto <strong>VaR Assimétrico (NCT)</strong> não se aplica a este fundo.
        </p>
        <p className="text-xs">
          Skewness = {skewnessRet.toFixed(3)} (≥ 0) — método indicado para assimetria negativa
          (crédito/FIDC). Use VaR Histórico / MC(t).
        </p>
      </div>
    );
  }

  if (skewnessRet != null && skewnessRet < 0 && var95Asm == null && !temDiagAsm) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground space-y-2">
        <p>
          Skewness negativa ({skewnessRet.toFixed(3)}), mas o ajuste <strong>NCT</strong> não
          convergiu para este CNPJ.
        </p>
        <p className="text-xs">
          Série curta, outliers ou scipy indisponível no último run do script. Reexecute{" "}
          <code className="text-[11px]">atualizar-betas-por-cnpj.py</code> ou use VaR Histórico.
        </p>
      </div>
    );
  }

  const asmIndisponivel = var95Asm == null || var95Asm === 0;

  return (
    <div className="space-y-6">
      {asmIndisponivel && skewnessRet != null && skewnessRet < 0 && temDiagAsm && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-1">
          <p>
            <strong>VaR Assim indisponível</strong> — ajuste NCT insuficiente para esta série
            {kurtosisRet != null && kurtosisRet > 50 && (
              <> (kurtosis = {kurtosisRet.toFixed(1)})</>
            )}
            {ncAsm != null && ncAsm > 0 && skewnessRet < -0.5 && (
              <>; <code className="text-[10px]">nc</code> positivo com skew negativa indica mínimo local incorreto</>
            )}
            .
          </p>
          <p>
            Use <strong>VaR Histórico</strong> ({fmtPct(var95Hist)}) como referência principal.
          </p>
        </div>
      )}
      {var95Asm != null && var95Asm !== 0 && qualidadeAjusteAsm === "fraco" && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Ajuste NCT fraco (kurtosis extrema ou outliers) — use <strong>VaR Histórico</strong> como
          referência principal. Este valor é indicativo.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "VaR Assim 95%",
            value: asmExibivel ? fmtPct(var95Asm!) : "n/a",
            color: asmExibivel ? C.asm : C.tick,
          },
          {
            label: "VaR Assim 99%",
            value: var99Asm != null && var99Asm !== 0 ? fmtPct(var99Asm) : "n/a",
            color: C.var99,
          },
          {
            label: "CVaR Assim 95%",
            value: cvar95Asm != null && cvar95Asm !== 0 ? fmtPct(cvar95Asm) : "n/a",
            color: C.cvar,
          },
          {
            label: "Qualidade ajuste",
            value: qualidadeAjusteAsm ?? "—",
            color: qualidadeAjusteAsm === "fraco" ? C.var95 : C.ok,
          },
        ].map((it) => (
          <div key={it.label} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">{it.label}</div>
            <div className="text-sm font-semibold font-mono capitalize" style={{ color: it.color }}>
              {it.value}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        {skewnessRet != null && <span>Skewness: <strong className="font-mono">{skewnessRet.toFixed(3)}</strong></span>}
        {kurtosisRet != null && <span>Kurtosis: <strong className="font-mono">{kurtosisRet.toFixed(2)}</strong></span>}
        {dfAsm != null && <span>df (NCT): <strong className="font-mono">{dfAsm.toFixed(1)}</strong></span>}
        {ncAsm != null && (
          <span>
            nc: <strong className="font-mono">{ncAsm.toFixed(3)}</strong>
            {ncAsm < -0.3 && " — cauda esquerda pesada"}
            {ncAsm > 0 && skewnessRet != null && skewnessRet < -0.5 && " — sinal inconsistente"}
          </span>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
          Comparativo 21d — métodos univariados
        </p>
        <ResponsiveContainer width="100%" height={Math.max(120, comparativo.length * 36)}>
          <BarChart data={comparativo} layout="vertical" margin={{ left: 8, right: 24 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.tick} strokeOpacity={0.25} />
            <XAxis type="number" tickFormatter={(v: number) => fmtPct2(v)} tick={TICK} />
            <YAxis type="category" dataKey="metodo" tick={TICK} width={110} />
            <Tooltip formatter={(v: number) => [fmtPct(v), "VaR 95%"]} />
            <Bar dataKey="valor" radius={[0, 4, 4, 0]}>
              {comparativo.map((entry) => (
                <Cell key={entry.metodo} fill={entry.cor} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="text-[10px] text-muted-foreground mt-1">
          4º método indicativo — Non-Central t, 10.000 simulações × 21 passos (Python offline).
          {!asmExibivel && " VaR Assim omitido quando ajuste NCT é insuficiente."}{" "}
          Não substitui VaR Histórico nem entra em limites de carteira.
        </p>
      </div>
    </div>
  );
}

// ─── Componente principal ────────────────────────────────────────────────────

export function VarDistributionCharts({
  cnpj,
  nome,
  retornos,
  var95,
  var99,
  cvar95,
  benchmark,
  bvar95,
  var95McT,
  var95Asm,
  var99Asm,
  cvar95Asm,
  dfAsm,
  ncAsm,
  skewnessRet,
  kurtosisRet,
  qualidadeAjusteAsm,
  onRefresh,
  isRefreshing,
}: VarDistributionChartsProps) {
  const [aba, setAba] = useState<Aba>("historico");

  if (retornos.length < 30) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">{nome}</div>
        <div className="text-xs text-muted-foreground font-mono mb-4">{cnpj}</div>
        <div className="py-10 text-center text-sm text-muted-foreground">
          Histórico insuficiente para análise de distribuição (mínimo 30 observações).
        </div>
      </div>
    );
  }

  const abas: { key: Aba; label: string }[] = [
    { key: "historico", label: "Histórico" },
    { key: "parametrico", label: "Paramétrico" },
    { key: "mc", label: "Monte Carlo" },
    { key: "assimetrico", label: "VaR Assim" },
    { key: "bvar", label: "B-VaR (vs Benchmark)" },
  ];

  const rets = retornos.map((r) => r.ret);
  const var95Loss = varComoPerda(var95);
  const var99Loss = varComoPerda(var99);
  const cvar95Loss = varComoPerda(cvar95);
  const var95AsmLoss = var95Asm != null ? varComoPerda(var95Asm) : null;
  const var99AsmLoss = var99Asm != null ? varComoPerda(var99Asm) : null;
  const cvar95AsmLoss = cvar95Asm != null ? varComoPerda(cvar95Asm) : null;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-foreground">{nome}</div>
          <div className="text-xs text-muted-foreground font-mono">{cnpj}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground">
            {retornos.length} obs · {retornos[0]?.data} a {retornos[retornos.length - 1]?.data}
          </div>
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Atualizar série de retornos e métricas deste fundo"
            >
              {isRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Atualizar
            </Button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <KpiRow var95={var95Loss} var99={var99Loss} cvar95={cvar95Loss} retornos={rets} />

      {/* Tabs */}
      <div className="flex border-b border-border mb-5 gap-0 -mx-1 overflow-x-auto">
        {abas.map((a) => (
          <button
            key={a.key}
            onClick={() => setAba(a.key)}
            className={`px-4 py-2 text-sm transition-colors relative whitespace-nowrap ${
              aba === a.key
                ? "text-primary font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {a.label}
            {a.key === "assimetrico" && (
              <span className="ml-1 text-[9px] font-normal text-violet-600 uppercase">piloto</span>
            )}
            {aba === a.key && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* Conteúdo da aba */}
      {aba === "historico" && (
        <AbaHistorico retornos={retornos} var95={var95Loss} var99={var99Loss} cvar95={cvar95Loss} />
      )}
      {aba === "parametrico" && <AbaParametrico retornos={retornos} />}
      {aba === "mc" && <AbaMonteCarlo retornos={retornos} />}
      {aba === "assimetrico" && (
        <AbaAssimetrico
          var95Hist={var95Loss}
          var95McT={var95McT != null ? varComoPerda(var95McT) : null}
          var95Asm={var95AsmLoss}
          var99Asm={var99AsmLoss}
          cvar95Asm={cvar95AsmLoss}
          skewnessRet={skewnessRet}
          kurtosisRet={kurtosisRet}
          dfAsm={dfAsm}
          ncAsm={ncAsm}
          qualidadeAjusteAsm={qualidadeAjusteAsm}
        />
      )}
      {aba === "bvar" && (
        <AbaBVaR retornos={retornos} benchmark={benchmark} bvar95={bvar95} />
      )}
    </div>
  );
}

export default VarDistributionCharts;
