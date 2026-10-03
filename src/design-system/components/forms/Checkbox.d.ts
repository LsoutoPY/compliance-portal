export interface CheckboxProps {
  label?: React.ReactNode;
  /** Linha secundária — use para explicar o efeito da marcação. */
  description?: string;
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  className?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
