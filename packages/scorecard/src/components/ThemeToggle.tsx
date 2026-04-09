import { useTheme } from "../context/ThemeContext";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="border border-border px-2 py-1 text-secondary hover:text-primary transition-colors"
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: "18px", lineHeight: 1, verticalAlign: "middle" }}
      >
        {theme === "light" ? "dark_mode" : "light_mode"}
      </span>
    </button>
  );
}
