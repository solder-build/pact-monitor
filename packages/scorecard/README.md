# @pact-network/scorecard

Public-facing API reliability dashboard for Pact Network. Vite + React SPA.

## Deploy target

The scorecard is served at `https://pactnetwork.io/scorecard` as a static bundle hosted inside the `pact-network-landing` Astro repo under `public/scorecard/`. A Vercel rewrite in the landing repo provides SPA fallback for deep links.

All emitted asset URLs are rooted at `/scorecard/` via `base: "/scorecard/"` in `vite.config.ts`. The React Router uses `basename="/scorecard"` in `src/App.tsx`. These two must stay aligned.

## API URL

The client reads `VITE_API_URL` at build time.

- `.env.production` — `VITE_API_URL=https://api.pactnetwork.io`
- `.env.development` — empty, so dev uses Vite's `/api` proxy to the local backend on `BACKEND_PORT` (default `3001`).

Requests go to `${VITE_API_URL}/api/v1/...`.

## Dev

```bash
# From packages/scorecard
npm run dev
```

Backend must be running on `http://localhost:${BACKEND_PORT:-3001}`.

## Build

```bash
npm run build
```

Outputs to `dist/`. To refresh the hosted bundle:

```bash
rm -rf /path/to/landing/public/scorecard
cp -r dist /path/to/landing/public/scorecard
```

Then commit the result in the landing repo.
