import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";

export interface ComiteSlice {
  name: string;
  value: number;
  color: string;
}

export function RelatorioComiteChart({ data }: { data: ComiteSlice[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        Sem dados para exibir
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          dataKey="value"
          label={({ name, value }) => `${name}: ${value}`}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip formatter={(value: number, name: string) => [value, name]} />
      </PieChart>
    </ResponsiveContainer>
  );
}
