import { useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

/** True when month-end reports any attention-severity nudges. */
export function useMonthEndAttention(): boolean {
  const [needsAttention, setNeedsAttention] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const month = new Date().toISOString().slice(0, 7);
    void callEdgeFunction("month-end", { month }).then((res) => {
      if (cancelled) return;
      const n = Number(
        (res.body.summary as { needs_attention?: number } | undefined)
          ?.needs_attention,
      );
      setNeedsAttention(res.ok && Number.isFinite(n) && n > 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return needsAttention;
}
