# pact-network skill

Claude Code skill for integrating the Pact Network SDKs into your project.

Pact Network is parametric micro-insurance for AI agent API payments on
Solana. This skill covers both SDKs:

- **`@pact-network/monitor`** — wraps `fetch()` to track API reliability
  and sync signed records to the backend.
- **`@pact-network/insurance`** — manages on-chain parametric insurance
  policies on Solana: enable a policy, delegate a USDC premium budget,
  submit claims.

## Install

```bash
npx skills add solder-build/pact-skill
```

Or manually copy `SKILL.md` into your project's `.claude/skills/` directory.

## Usage

In Claude Code, invoke with:

```
/pact-network
```

Argument hint: `monitor`, `insurance`, or `both` (default).

The skill walks your agent through install, config, `fetch()` replacement,
anti-fraud keypair signing, on-chain policy enablement, claim submission,
and common integration patterns for AI agent frameworks, Express/Fastify,
and Next.js.

## Source of Truth

The canonical `SKILL.md` lives in the `pact-monitor` monorepo at
`skill/SKILL.md`. This repo is synced from there on every release — edit
the monorepo copy, not this one.

## Links

- [Pact Network Scorecard](https://pactnetwork.io)
- [Monorepo](https://github.com/solder-build/pact-monitor)
- [Monitor SDK source](https://github.com/solder-build/pact-monitor/tree/main/packages/monitor)
- [Insurance SDK source](https://github.com/solder-build/pact-monitor/tree/main/packages/insurance)
- [Samples](https://github.com/solder-build/pact-monitor/tree/main/samples)

## License

MIT
