import React from "react";

const TONES = {
  neutral: ["var(--surface-sunken)", "var(--text-body)", "var(--border-default)"],
  brand: ["var(--surface-brand-subtle)", "var(--text-brand)", "var(--teal-200)"],
  positive: ["var(--surface-positive)", "var(--text-positive)", "var(--green-500)"],
  warning: ["var(--surface-warning)", "var(--text-warning)", "var(--amber-500)"],
  attention: ["var(--surface-attention)", "var(--text-attention)", "var(--orange-500)"],
  negative: ["var(--surface-negative)", "var(--text-negative)", "var(--red-500)"],
  info: ["var(--surface-info)", "var(--text-info)", "var(--blue-500)"]
};

export function Badge({ children, tone = "neutral", variant = "soft", size = "sm", dot, className = "", ...rest }) {
  const [bg, fg, line] = TONES[tone] || TONES.neutral;
  const style = variant === "solid"
    ? { background: fg, color: "var(--neutral-0)" }
    : variant === "outline"
      ? { background: "transparent", color: fg, borderColor: line }
      : { background: bg, color: fg };
  return (
    <span className={["rcv-badge", size === "md" ? "rcv-badge--md" : "", className].filter(Boolean).join(" ")} style={style} {...rest}>
      {dot ? <span className="rcv-badge__dot" /> : null}
      {children}
    </span>
  );
}
