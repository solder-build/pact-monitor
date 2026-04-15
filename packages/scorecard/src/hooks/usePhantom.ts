import { useCallback, useEffect, useState } from "react";

// Minimal typing for the Phantom-injected provider. We deliberately don't
// pull in @solana/wallet-adapter-react because the faucet page is the only
// wallet-aware surface in the scorecard — a full adapter stack is ~200kB of
// extra bundle for one button. window.phantom.solana is the documented
// injection point; connect() returns the public key directly.
interface PhantomEvent {
  publicKey?: { toString(): string };
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<PhantomEvent>;
  disconnect(): Promise<void>;
  on(event: string, handler: (args: unknown) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  }
}

function getProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const injected = window.phantom?.solana ?? window.solana ?? null;
  if (injected && injected.isPhantom) return injected;
  return null;
}

export interface UsePhantom {
  provider: PhantomProvider | null;
  pubkey: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function usePhantom(): UsePhantom {
  const [provider, setProvider] = useState<PhantomProvider | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = getProvider();
    setProvider(p);
    if (!p) return;

    // Try a silent re-connect on mount so a returning user doesn't have to
    // click "Connect" every time. onlyIfTrusted skips the approval popup.
    p.connect({ onlyIfTrusted: true })
      .then((res) => {
        if (res.publicKey) setPubkey(res.publicKey.toString());
      })
      .catch(() => {
        // Expected on first visit — user hasn't approved the dapp yet.
      });

    const onDisconnect = () => setPubkey(null);
    p.on("disconnect", onDisconnect);
    const onAccountChanged = (next: unknown) => {
      const kp = next as PhantomEvent;
      setPubkey(kp?.publicKey ? kp.publicKey.toString() : null);
    };
    p.on("accountChanged", onAccountChanged);
  }, []);

  const connect = useCallback(async () => {
    const p = getProvider();
    if (!p) {
      setError(
        "Phantom wallet not detected. Install from phantom.app, refresh, then try again.",
      );
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await p.connect();
      if (res.publicKey) setPubkey(res.publicKey.toString());
      setProvider(p);
    } catch (err) {
      setError((err as Error).message || "Failed to connect to Phantom");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const p = provider;
    if (!p) return;
    try {
      await p.disconnect();
    } finally {
      setPubkey(null);
    }
  }, [provider]);

  return { provider, pubkey, connecting, error, connect, disconnect };
}
