export interface SelectOption { value: string; label: string }
export interface SelectProps {
  label?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: SelectOption[];
  placeholder?: string;
  hint?: string;
  error?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  id?: string;
  className?: string;
}
export declare function Select(props: SelectProps): JSX.Element;
