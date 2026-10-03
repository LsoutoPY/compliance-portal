export interface IconProps {
  /** Nome do glifo Lucide em kebab-case, ex. "trending-down". */
  name: string;
  /** Lado do quadrado em px. 16 em tabelas, 18 em botões, 20 na navegação. */
  size?: number;
  /** Cor do glifo. Padrão currentColor. */
  color?: string;
  /** Pacote/versão CDN do lucide-static. */
  strokeSet?: string;
  style?: React.CSSProperties;
}
export declare function Icon(props: IconProps): JSX.Element;
