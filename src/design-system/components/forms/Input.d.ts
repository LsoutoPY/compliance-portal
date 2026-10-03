export interface InputProps {
  label?: string;
  value?: string | number;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  /** Texto auxiliar abaixo do campo. Substituído por error quando houver. */
  hint?: string;
  error?: string;
  /** Glifo Lucide à esquerda, ex. "search". */
  icon?: string;
  /** Sufixo textual: "%", "R$", "dias". */
  suffix?: string;
  type?: string;
  /** Alinha à direita em fonte mono com tabular-nums — obrigatório para valores. */
  numeric?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
}
export declare function Input(props: InputProps): JSX.Element;
