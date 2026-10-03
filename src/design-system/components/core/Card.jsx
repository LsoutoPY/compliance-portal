import React from "react";

export function Card({ title, subtitle, actions, footer, children, padding = true, interactive, onClick, className = "", style, ...rest }) {
  return (
    <section className={["rcv-card", interactive ? "rcv-card--interactive" : "", className].filter(Boolean).join(" ")} onClick={onClick} style={style} {...rest}>
      {title || actions ? (
        <header className="rcv-card__head">
          <div>
            {title ? <h3 className="rcv-card__title">{title}</h3> : null}
            {subtitle ? <p className="rcv-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div style={{ display: "flex", gap: "var(--space-2)", flex: "none" }}>{actions}</div> : null}
        </header>
      ) : null}
      <div className="rcv-card__body" style={padding ? undefined : { padding: 0 }}>{children}</div>
      {footer ? <footer className="rcv-card__foot">{footer}</footer> : null}
    </section>
  );
}
