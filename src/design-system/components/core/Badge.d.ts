export interface BadgeProps {
  children?: React.ReactNode;
  /** Semântica, não decoração: positive/negative só para resultado, brand para classificação. */
  tone?: "neutral" | "brand" | "positive" | "warning" | "attention" | "negative" | "info";
  variant?: "soft" | "solid" | "outline";
  size?: "sm" | "md";
  /** Ponto colorido antes do texto — use em status de processo. */
  dot?: boolean;
  className?: string;
  title?: string;
}
export declare function Badge(props: BadgeProps): JSX.Element;
