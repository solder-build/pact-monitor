#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Pact Network — Dev Setup ==="
echo ""

# ── Prerequisites ────────────────────────────────────────────
echo "[check] Verifying prerequisites..."

command -v node >/dev/null 2>&1 || { echo "  Error: Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "  Error: pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "  Error: Docker is required. Install from https://docker.com"; exit 1; }

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "  Error: Node.js 20+ required (you have $(node -v))"
  exit 1
fi

echo "  Node $(node -v), pnpm $(pnpm -v), Docker $(docker -v | cut -d' ' -f3 | tr -d ',')"
echo ""

# ── Step 1: Dependencies ────────────────────────────────────
echo "[1/5] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo ""

# ── Step 2: PostgreSQL via Docker Compose ───────────────────
echo "[2/5] Starting PostgreSQL..."
docker compose -f docker-compose.dev.yml up -d 2>/dev/null

# Wait for healthy status (docker compose healthcheck)
echo "  Waiting for PostgreSQL to be healthy..."
RETRIES=0
MAX_RETRIES=30
while [ $RETRIES -lt $MAX_RETRIES ]; do
  HEALTH=$(docker inspect --format='{{.State.Health.Status}}' pact-pg 2>/dev/null || echo "missing")
  if [ "$HEALTH" = "healthy" ]; then
    echo "  PostgreSQL is healthy"
    break
  fi
  RETRIES=$((RETRIES + 1))
  if [ $RETRIES -eq $MAX_RETRIES ]; then
    echo "  Warning: PostgreSQL health check timed out. Trying pg_isready fallback..."
    if docker exec pact-pg pg_isready -U pact >/dev/null 2>&1; then
      echo "  PostgreSQL is accepting connections"
    else
      echo "  Error: PostgreSQL failed to start. Check: docker logs pact-pg"
      exit 1
    fi
  fi
  sleep 1
done
echo ""

# ── Step 3: Environment ────────────────────────────────────
echo "[3/5] Creating .env files..."
if [ ! -f packages/backend/.env ]; then
  cp .env.example packages/backend/.env
  echo "  Created packages/backend/.env from .env.example"
else
  echo "  packages/backend/.env already exists (skipped)"
fi
echo ""

# ── Step 4: API Key ─────────────────────────────────────────
echo "[4/5] Generating API key..."
API_KEY_OUTPUT=$(cd packages/backend && pnpm tsx src/scripts/generate-key.ts dev-agent 2>&1) || true
API_KEY=$(echo "$API_KEY_OUTPUT" | grep '^pact_')
if [ -n "$API_KEY" ]; then
  echo "  API Key: $API_KEY"
  echo "  (Save this — you'll need it for the SDK)"
else
  echo "  Key generation skipped (may already exist)"
fi
echo ""

# ── Step 5: Seed Data ───────────────────────────────────────
echo "[5/5] Seeding database..."
(cd packages/backend && pnpm tsx src/scripts/seed.ts)
echo ""

# ── Done ────────────────────────────────────────────────────
echo "=== Setup Complete ==="
echo ""
echo "Commands:"
echo "  pnpm dev:backend      Start API server (port 3000)"
echo "  pnpm dev:scorecard    Start dashboard (port 5173)"
echo "  pnpm test             Run all tests"
echo "  pnpm run seed         Re-seed database"
echo ""
echo "Open http://localhost:5173 after starting both servers."
echo ""
