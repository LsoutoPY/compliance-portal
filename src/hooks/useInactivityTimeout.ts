import { useCallback, useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"] as const;
const ACTIVITY_THROTTLE_MS = 30_000;

export const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

export function useInactivityTimeout(options: {
  enabled: boolean;
  timeoutMs: number;
  onTimeout: () => void;
}) {
  const { enabled, timeoutMs, onTimeout } = options;
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const lastActivityRef = useRef(Date.now());
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const resetTimer = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      onTimeoutRef.current();
    }, timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }

    let lastThrottle = 0;

    const registerActivity = () => {
      const now = Date.now();
      if (now - lastThrottle < ACTIVITY_THROTTLE_MS) return;
      lastThrottle = now;
      lastActivityRef.current = now;
      resetTimer();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;

      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        onTimeoutRef.current();
        return;
      }

      resetTimer();
    };

    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, registerActivity, { passive: true });
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    lastActivityRef.current = Date.now();
    resetTimer();

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      ACTIVITY_EVENTS.forEach((event) => {
        window.removeEventListener(event, registerActivity);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, resetTimer, timeoutMs]);
}
