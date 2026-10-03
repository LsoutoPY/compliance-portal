export interface SegmentedOption { value: string; label: string; icon?: string }
export interface SegmentedControlProps {
  options: SegmentedOption[];
  value?: string;
  onChange?: (value: string) => void;
  size?: "md" | "lg";
  className?: string;
}
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
