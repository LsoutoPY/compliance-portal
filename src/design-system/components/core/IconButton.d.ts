export interface IconButtonProps {
  /** Glifo Lucide. */
  icon: string;
  /** Rótulo acessível — obrigatório, vira aria-label e title. */
  label: string;
  variant?: "ghost" | "secondary" | "primary";
  size?: "sm" | "md" | "lg";
  /** Estado de alternância (aria-pressed) — pinta o botão com a superfície selecionada. */
  pressed?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
