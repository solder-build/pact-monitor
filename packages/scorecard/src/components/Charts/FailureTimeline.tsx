import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { TimeseriesPoint } from "../../api/client";
import { useChartColors } from "../../hooks/useChartColors";

export function FailureTimeline({ data }: { data: TimeseriesPoint[] }) {
  const colors = useChartColors();
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric" }),
    rate: parseFloat((d.failure_rate * 100).toFixed(2)),
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={formatted}>
        <XAxis dataKey="label" tick={{ fill: colors.axisTick, fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tick={{ fill: colors.axisTick, fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, color: colors.tooltipText, fontFamily: "JetBrains Mono", fontSize: 12 }}
          formatter={(value: number) => [`${value}%`, "Failure Rate"]}
        />
        <Bar dataKey="rate" fill="#B87333" />
      </BarChart>
    </ResponsiveContainer>
  );
}
