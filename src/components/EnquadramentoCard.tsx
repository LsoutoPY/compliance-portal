import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, Edit2, Calendar, FileText, MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusEnquadramento = "ativo" | "pendente" | "inativo";

export interface Enquadramento {
  id: string;
  nome: string;
  descricao: string;
  status: StatusEnquadramento;
  dataCriacao: string;
}

interface EnquadramentoCardProps {
  enquadramento: Enquadramento;
  onEdit: (enquadramento: Enquadramento) => void;
  onDelete: (id: string) => void;
}

const statusConfig: Record<StatusEnquadramento, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
  ativo: { 
    label: "Ativo", 
    variant: "default",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
  },
  pendente: { 
    label: "Pendente", 
    variant: "secondary",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
  },
  inativo: { 
    label: "Inativo", 
    variant: "outline",
    className: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
  },
};

export function EnquadramentoCard({ enquadramento, onEdit, onDelete }: EnquadramentoCardProps) {
  const config = statusConfig[enquadramento.status];

  return (
    <Card className="group hover:shadow-lg transition-all duration-300 border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
      <div className={cn(
        "h-1 w-full",
        enquadramento.status === "ativo" ? "bg-emerald-500" : 
        enquadramento.status === "pendente" ? "bg-amber-500" : "bg-slate-300 dark:bg-slate-700"
      )} />
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <FileText className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              </div>
              <h3 className="font-bold text-foreground truncate text-lg">{enquadramento.nome}</h3>
            </div>
            
            <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
              {enquadramento.descricao}
            </p>
            
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Badge variant="outline" className={cn("font-medium", config.className)}>
                {config.label}
              </Badge>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                <Calendar className="h-3 w-3" />
                <span>{new Date(enquadramento.dataCriacao).toLocaleDateString('pt-BR')}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter className="p-3 bg-slate-50/50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => onEdit(enquadramento)}
        >
          <Edit2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Editar</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(enquadramento.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Excluir</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
