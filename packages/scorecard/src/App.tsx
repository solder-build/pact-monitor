import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, Link } from "react-router-dom";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderDetail } from "./components/ProviderDetail";
import { PoolDetail } from "./components/PoolDetail";
import { ThemeToggle } from "./components/ThemeToggle";
import { AdminDashboard } from "./components/AdminDashboard";
import { FaucetPage } from "./components/FaucetPage";
import { AgentGuide } from "./components/AgentGuide";
import { UnderwriterGuide } from "./components/UnderwriterGuide";
import { track } from "./analytics/tracker";

function PageTracker() {
  const location = useLocation();

  useEffect(() => {
    track("page_view", { path: location.pathname });
  }, [location.pathname]);

  return null;
}

export function App() {
  useEffect(() => {
    track("session_start");
  }, []);

  return (
    <BrowserRouter basename="/scorecard">
      <PageTracker />
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="border-b border-border px-8 py-4 flex items-center justify-between">
          <div>
            <Link to="/" className="no-underline">
              <h1 className="font-serif text-xl text-primary tracking-wide">
                Pact Network
              </h1>
              <p className="text-sm text-secondary font-sans">
                API Reliability Scorecard
              </p>
            </Link>
          </div>
          <div className="flex items-center gap-6">
            <nav className="flex gap-4 font-mono text-xs uppercase tracking-widest">
              <Link to="/" className="text-secondary hover:text-primary">Rankings</Link>
              <Link to="/faucet" className="text-secondary hover:text-primary">Faucet</Link>
            </nav>
            <ThemeToggle />
          </div>
        </header>
        <main className="px-8 py-6 flex-1">
          <Routes>
            <Route path="/" element={<ProviderTable />} />
            <Route path="/provider/:id" element={<ProviderDetail />} />
            <Route path="/pool/:hostname" element={<PoolDetail />} />
            <Route path="/guide/agent" element={<AgentGuide />} />
            <Route path="/guide/underwriter" element={<UnderwriterGuide />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/faucet" element={<FaucetPage />} />
          </Routes>
        </main>
        <footer className="border-t border-border px-8 py-6">
          <div className="grid grid-cols-3 gap-8">
            <div>
              <p className="text-xs text-muted uppercase tracking-widest font-mono mb-3">Guides</p>
              <div className="flex flex-col gap-2">
                <Link to="/guide/agent" className="text-sm text-secondary hover:text-primary font-sans">Agent Quickstart</Link>
                <Link to="/guide/underwriter" className="text-sm text-secondary hover:text-primary font-sans">Underwriter Quickstart</Link>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted uppercase tracking-widest font-mono mb-3">Tools</p>
              <div className="flex flex-col gap-2">
                <Link to="/faucet" className="text-sm text-secondary hover:text-primary font-sans">TEST-USDC Faucet</Link>
                <Link to="/" className="text-sm text-secondary hover:text-primary font-sans">Provider Rankings</Link>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted uppercase tracking-widest font-mono mb-3">Pact Network</p>
              <p className="text-xs text-muted font-sans">Parametric insurance for AI agent API calls on Solana.</p>
            </div>
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
}
