#!/usr/bin/env bash
set -e

echo "=== Pact Network — Dev Setup ==="
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: Docker is required. Install from https://docker.com"; exit 1; }

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js 20+ required (you have $(node -v))"
  exit 1
fi

echo "[1/5] Installing dependencies..."
pnpm install

echo ""
echo "[2/5] Starting PostgreSQL..."
if docker ps -a --format '{{.Names}}' | grep -q '^pact-pg$'; then
  if docker ps --format '{{.Names}}' | grep -q '^pact-pg$'; then
    echo "  PostgreSQL already running"
  else
    docker start pact-pg
    echo "  PostgreSQL started (existing container)"
  fi
else
  docker run -d \
    --name pact-pg \
    -e POSTGRES_USER=pact \
    -e POSTGRES_PASSWORD=pact \
    -e POSTGRES_DB=pact \
    -p 5432:5432 \
    postgres:16-alpine
  echo "  PostgreSQL started (new container)"
fi

# Wait for postgres to be ready
echo "  Waiting for PostgreSQL to accept connections..."
for i in $(seq 1 15); do
  if docker exec pact-pg pg_isready -U pact >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "[3/5] Creating .env files..."
if [ ! -f packages/backend/.env ]; then
  cp .env.example packages/backend/.env
  echo "  Created packages/backend/.env"
else
  echo "  packages/backend/.env already exists"
fi

echo ""
echo "[4/5] Generating API key..."
API_KEY_OUTPUT=$(cd packages/backend && pnpm tsx src/scripts/generate-key.ts dev-agent 2>&1)
API_KEY=$(echo "$API_KEY_OUTPUT" | grep '^pact_')
if [ -n "$API_KEY" ]; then
  echo "  API Key: $API_KEY"
  echo "  (Save this — you'll need it for the SDK)"
else
  echo "  Key generation skipped (may already exist)"
fi

echo ""
echo "[5/5] Seeding database..."
cd packages/backend && pnpm tsx src/scripts/seed.ts
cd ../..

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start developing:"
echo "  Terminal 1:  pnpm dev:backend"
echo "  Terminal 2:  pnpm dev:scorecard"
echo "  Browser:     http://localhost:5173"
echo ""
echo "To run tests:"
echo "  pnpm test"
echo ""
