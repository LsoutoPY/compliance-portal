import type { LucideIcon } from "lucide-react";

interface RelatorioPageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}

export function RelatorioPageHeader({ icon: Icon, title, subtitle }: RelatorioPageHeaderProps) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-border pb-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <Icon className="h-6 w-6" />
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}
