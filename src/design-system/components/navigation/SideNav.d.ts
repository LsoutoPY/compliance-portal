export interface SideNavItem { id: string; label: string; icon: string; badge?: string | number; section?: string }
/**
 * Navegação lateral persistente da plataforma (Verde Cofre escuro em ambos os temas).
 * @startingPoint section="Navegação" subtitle="Barra lateral, abas e trilha de navegação" viewport="700x280"
 */
export interface SideNavProps {
  items: SideNavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** 64px, só glifos — padrão em telas < 1280px. */
  collapsed?: boolean;
  /** Texto da marca (sem logotipo fornecido, é tipografia). */
  brand?: string;
  footer?: React.ReactNode;
  className?: string;
}
export declare function SideNav(props: SideNavProps): JSX.Element;
