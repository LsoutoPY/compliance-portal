import React from "react";
import { Icon } from "./Icon.jsx";

export function Button({ children, variant = "primary", size = "md", icon, iconRight, block, disabled, loading, type = "button", onClick, className = "", ...rest }) {
  const cls = ["rcv-btn", "rcv-btn--" + variant, size !== "md" ? "rcv-btn--" + size : "", block ? "rcv-btn--block" : "", className].filter(Boolean).join(" ");
  const glyph = size === "sm" ? 15 : size === "lg" ? 19 : 17;
  return (
    <button type={type} className={cls} disabled={disabled || loading} onClick={onClick} {...rest}>
      {loading ? <Icon name="loader-circle" size={glyph} style={{ animation: "rcv-spin 900ms linear infinite" }} /> : icon ? <Icon name={icon} size={glyph} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={glyph} /> : null}
    </button>
  );
}
