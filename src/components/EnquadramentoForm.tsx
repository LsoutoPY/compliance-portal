import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Enquadramento, StatusEnquadramento } from "./EnquadramentoCard";

interface EnquadramentoFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enquadramento?: Enquadramento | null;
  onSave: (enquadramento: Omit<Enquadramento, "id" | "dataCriacao">) => void;
}

export function EnquadramentoForm({ open, onOpenChange, enquadramento, onSave }: EnquadramentoFormProps) {
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [status, setStatus] = useState<StatusEnquadramento>("pendente");

  useEffect(() => {
    if (enquadramento) {
      setNome(enquadramento.nome);
      setDescricao(enquadramento.descricao);
      setStatus(enquadramento.status);
    } else {
      setNome("");
      setDescricao("");
      setStatus("pendente");
    }
  }, [enquadramento, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nome.trim()) return;
    
    onSave({ nome, descricao, status });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby="dialog-description">
        <DialogHeader>
          <DialogTitle>
            {enquadramento ? "Editar Enquadramento" : "Novo Enquadramento"}
          </DialogTitle>
          <div id="dialog-description" className="sr-only">
            Formulário para {enquadramento ? "editar" : "criar"} um enquadramento
          </div>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="nome">Nome</Label>
            <Input
              id="nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome do enquadramento"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="descricao">Descrição</Label>
            <Textarea
              id="descricao"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Descrição do enquadramento"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusEnquadramento)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ativo">Ativo</SelectItem>
                <SelectItem value="pendente">Pendente</SelectItem>
                <SelectItem value="inativo">Inativo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit">
              {enquadramento ? "Salvar" : "Criar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
