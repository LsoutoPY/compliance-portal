import React from "react";
import { Icon } from "./Icon.jsx";

export function IconButton({ icon, label, variant = "ghost", size = "md", pressed, disabled, onClick, className = "", ...rest }) {
  const cls = ["rcv-iconbtn", variant !== "ghost" ? "rcv-iconbtn--" + variant : "", size !== "md" ? "rcv-iconbtn--" + size : "", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} {...rest}>
      <Icon name={icon} size={size === "sm" ? 15 : size === "lg" ? 20 : 18} />
    </button>
  );
}
