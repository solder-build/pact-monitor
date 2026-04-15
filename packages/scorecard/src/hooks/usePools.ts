import { useEffect, useState } from "react";
import { getPools, type PoolSummary } from "../api/client";

export function usePools() {
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      getPools()
        .then((p) => {
          if (mounted) {
            setPools(p);
            setError(null);
          }
        })
        .catch((e) => {
          if (mounted) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return { pools, error };
}
