import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useChartColors } from "../../hooks/useChartColors";

const COLORS: Record<string, string> = {
  timeout: "#C9553D",
  error: "#B87333",
  schema_mismatch: "#5A6B7A",
};

export function FailureBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const colors = useChartColors();
  const data = Object.entries(breakdown).map(([key, value]) => ({
    name: key,
    count: value,
  }));

  if (data.length === 0) {
    return <p className="text-muted text-sm font-mono">No failures recorded</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical">
        <XAxis type="number" tick={{ fill: colors.axisTick, fontSize: 10 }} />
        <YAxis dataKey="name" type="category" tick={{ fill: colors.tooltipText, fontSize: 11, fontFamily: "JetBrains Mono" }} width={120} />
        <Tooltip
          contentStyle={{ background: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, color: colors.tooltipText, fontFamily: "JetBrains Mono", fontSize: 12 }}
        />
        <Bar dataKey="count">
          {data.map((entry) => (
            <Cell key={entry.name} fill={COLORS[entry.name] || "#5A6B7A"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
