import { AppShell } from "@/components/AppShell";
import { resolveShellMeta } from "@/config/portalNav";
import { useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
  noScroll?: boolean;
}

export function Layout({ children, noScroll = false }: LayoutProps) {
  const location = useLocation();
  const meta = resolveShellMeta(location.pathname);

  return (
    <AppShell
      activeId={meta.activeId}
      breadcrumbs={meta.breadcrumbs}
      title={meta.title}
      flush
    >
      <div className={cn(noScroll && "h-full min-h-0 overflow-hidden flex flex-col")}>
        {children}
      </div>
    </AppShell>
  );
}
