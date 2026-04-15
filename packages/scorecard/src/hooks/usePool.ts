import { useEffect, useState } from "react";
import { getPool, type PoolDetail } from "../api/client";

export function usePool(hostname: string | undefined) {
  const [pool, setPool] = useState<PoolDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(hostname));

  useEffect(() => {
    if (!hostname) {
      setPool(null);
      setError(null);
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);

    const load = () => {
      getPool(hostname)
        .then((p) => {
          if (mounted) {
            setPool(p);
            setError(null);
            setLoading(false);
          }
        })
        .catch((e) => {
          if (mounted) {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [hostname]);

  return { pool, error, loading };
}
