import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "../design-system/components/core/Button";
import { IconButton } from "../design-system/components/core/IconButton";
import { SegmentedControl } from "../design-system/components/forms/SegmentedControl";
import { Breadcrumbs } from "../design-system/components/navigation/Breadcrumbs";
import { SideNav } from "../design-system/components/navigation/SideNav";
import { PORTAL_NAV_ITEMS, ROUTE_MAP } from "../config/portalNav";
import type { UserRole } from "../types/database";
import { useState } from "react";

export interface AppShellProps {
  activeId: string;
  breadcrumbs: { label: string }[];
  title: string;
  topbarExtras?: React.ReactNode;
  footer?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  activeId,
  breadcrumbs,
  title,
  topbarExtras,
  footer,
  flush,
  children,
}: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [persona, setPersona] = useState<UserRole>("risco");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  function handleNav(id: string) {
    const route = ROUTE_MAP[id];
    if (route) navigate(route);
  }

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }

  const onImportPage =
    location.pathname.startsWith("/dados/importar") ||
    location.pathname.startsWith("/enquadramento/importar");

  return (
    <div className="rcv-app">
      <SideNav
        brand="Risco CVPAR"
        activeId={activeId}
        items={PORTAL_NAV_ITEMS}
        onSelect={handleNav}
        footer={footer}
      />

      <div className="shell">
        <header className="topbar">
          <div>
            <Breadcrumbs items={breadcrumbs} />
            <div className="topbar__title">{title}</div>
          </div>
          <div className="topbar__spacer" />

          {topbarExtras}

          <SegmentedControl
            value={persona}
            onChange={(value) => setPersona(value as UserRole)}
            options={[
              { value: "risco", label: "Risco" },
              { value: "compliance", label: "Compliance" },
            ]}
          />

          <IconButton
            icon={theme === "light" ? "sun" : "moon"}
            label="Alternar tema"
            variant="secondary"
            size="sm"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          />

          {persona === "risco" && !onImportPage ? (
            <Button variant="primary" size="sm" icon="upload" onClick={() => navigate("/dados/importar")}>
              Atualizar dados
            </Button>
          ) : null}
        </header>

        <main className={flush ? "rcv-scroll main main--flush" : "rcv-scroll main main--wide"}>
          {children}
        </main>
      </div>
    </div>
  );
}
