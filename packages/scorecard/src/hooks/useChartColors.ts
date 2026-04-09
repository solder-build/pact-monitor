import { useTheme } from "../context/ThemeContext";

export function useChartColors() {
  const { theme } = useTheme();

  return theme === "dark"
    ? {
        axisTick: "#5A6B7A",
        tooltipBg: "#1A1917",
        tooltipBorder: "#333330",
        tooltipText: "#ccc",
      }
    : {
        axisTick: "#7A7568",
        tooltipBg: "#FFFFFF",
        tooltipBorder: "#D5D0C8",
        tooltipText: "#2D2B28",
      };
}
