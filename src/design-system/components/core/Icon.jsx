import React from "react";

/* Glifos Lucide (lucide-static via CDN) aplicados como máscara CSS — herdam currentColor
   e mantêm o traço de 2px em qualquer tamanho. Nenhum SVG é desenhado à mão. */
export function Icon({ name, size = 18, color = "currentColor", strokeSet = "lucide-static@0.454.0", style, ...rest }) {
  const url = "https://unpkg.com/" + strokeSet + "/icons/" + name + ".svg";
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", flex: "none", width: size, height: size, background: color, WebkitMaskImage: "url(" + url + ")", maskImage: "url(" + url + ")", WebkitMaskSize: "contain", maskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center", ...style }}
      {...rest}
    />
  );
}
