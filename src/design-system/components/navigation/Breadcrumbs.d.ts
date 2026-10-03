export interface Crumb { label: string; id?: string }
export interface BreadcrumbsProps {
  items: Crumb[];
  onNavigate?: (id: string) => void;
  className?: string;
}
export declare function Breadcrumbs(props: BreadcrumbsProps): JSX.Element;
