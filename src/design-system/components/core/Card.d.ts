export interface CardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Botões/ícone-botões no canto superior direito. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** false remove o padding do corpo — use quando o conteúdo é uma tabela sangrada. */
  padding?: boolean;
  interactive?: boolean;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
