import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { format, parse, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type DateRefNavigatorBase = {
  /** Datas disponíveis (mais recente primeiro) */
  availableDates: string[];
  popoverAlign?: "start" | "end" | "center";
  placeholder?: string;
  className?: string;
};

/** Datas em YYYYMMDD + estado `Date` (enquadramento, liquidez) */
export type DateRefNavigatorYyyymmddProps = DateRefNavigatorBase & {
  datesFormat?: "yyyyMMdd";
  date: Date | undefined;
  onDateChange: (date: Date) => void;
  formatDateToDB: (d: Date) => string;
  formatLabel?: (d: Date) => string;
};

/** Datas em YYYY-MM-DD + string ISO (rentabilidade) */
export type DateRefNavigatorIsoProps = DateRefNavigatorBase & {
  datesFormat: "iso";
  selectedDate: string | null;
  onSelectedDateChange: (iso: string) => void;
};

export type DateRefNavigatorProps =
  | DateRefNavigatorYyyymmddProps
  | DateRefNavigatorIsoProps;

function isIsoProps(
  props: DateRefNavigatorProps,
): props is DateRefNavigatorIsoProps {
  return props.datesFormat === "iso";
}

/**
 * Seletor de data de referência com setas — mesmo padrão visual de
 * Controle Cotas > Rentabilidade: [←] [calendário outline] [→]
 */
export function DateRefNavigator(props: DateRefNavigatorProps) {
  const {
    availableDates,
    popoverAlign = "start",
    placeholder = "Selecionar data",
    className,
  } = props;

  const availableDatesMap = new Set(availableDates);

  const currentKey = isIsoProps(props)
    ? props.selectedDate
    : props.date
      ? props.formatDateToDB(props.date)
      : null;

  const idx = currentKey ? availableDates.indexOf(currentKey) : -1;

  const goOlder = () => {
    if (idx < 0 || idx >= availableDates.length - 1) return;
    const next = availableDates[idx + 1];
    if (isIsoProps(props)) {
      props.onSelectedDateChange(next);
    } else {
      props.onDateChange(parse(next, "yyyyMMdd", new Date()));
    }
  };

  const goNewer = () => {
    if (idx <= 0) return;
    const next = availableDates[idx - 1];
    if (isIsoProps(props)) {
      props.onSelectedDateChange(next);
    } else {
      props.onDateChange(parse(next, "yyyyMMdd", new Date()));
    }
  };

  const selectedCalendarDate = isIsoProps(props)
    ? props.selectedDate
      ? parseISO(props.selectedDate)
      : undefined
    : props.date;

  const dateKeyFromCalendar = (d: Date): string =>
    isIsoProps(props) ? format(d, "yyyy-MM-dd") : props.formatDateToDB(d);

  const labelText = (() => {
    if (isIsoProps(props)) {
      return props.selectedDate
        ? format(parseISO(props.selectedDate), "dd/MM/yyyy", { locale: ptBR })
        : null;
    }
    if (!props.date) return null;
    const fmt = props.formatLabel ?? ((d: Date) =>
      format(d, "dd/MM/yyyy", { locale: ptBR }));
    return fmt(props.date);
  })();

  const hasSelection = isIsoProps(props)
    ? !!props.selectedDate
    : !!props.date;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 flex-shrink-0"
        disabled={!hasSelection || idx < 0 || idx >= availableDates.length - 1}
        onClick={goOlder}
        title="Data anterior"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 w-[148px] justify-start text-left font-normal text-xs",
              !hasSelection && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            {labelText ? (
              <span className="font-semibold">{labelText}</span>
            ) : (
              <span>{placeholder}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align={popoverAlign}>
          <Calendar
            mode="single"
            selected={selectedCalendarDate}
            onSelect={(d) => {
              if (!d) return;
              if (isIsoProps(props)) {
                props.onSelectedDateChange(format(d, "yyyy-MM-dd"));
              } else {
                props.onDateChange(d);
              }
            }}
            locale={ptBR}
            modifiers={{
              hasData: (d) => availableDatesMap.has(dateKeyFromCalendar(d)),
              hasDataSelected: (d) =>
                !!currentKey &&
                dateKeyFromCalendar(d) === currentKey &&
                availableDatesMap.has(dateKeyFromCalendar(d)),
            }}
            modifiersClassNames={{
              hasData:
                "font-bold text-primary underline underline-offset-4 decoration-primary/50",
              hasDataSelected:
                "underline decoration-primary-foreground/80 underline-offset-2",
            }}
          />
        </PopoverContent>
      </Popover>

      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 flex-shrink-0"
        disabled={!hasSelection || idx <= 0}
        onClick={goNewer}
        title="Próxima data"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
