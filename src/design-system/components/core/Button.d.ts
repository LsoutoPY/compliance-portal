/**
 * Ação primária de formulários, cabeçalhos e diálogos.
 * @startingPoint section="Componentes" subtitle="Botões, ícone-botões, badges e cards" viewport="700x200"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** primary = uma por tela. secondary = ações de apoio. ghost = barra de ferramentas. danger = destrutiva. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** Nome do glifo Lucide à esquerda do rótulo. */
  icon?: string;
  /** Glifo à direita — use para "abrir em nova aba" ou chevrons. */
  iconRight?: string;
  block?: boolean;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  title?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;
