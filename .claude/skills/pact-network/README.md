# pact-network — Claude Code skill

Integrate the Pact Network SDKs for AI agents on Solana.

Pact Network is parametric micro-insurance for AI agent API payments on
Solana. It monitors API provider reliability, computes actuarially-derived
insurance rates, and pays USDC refunds on failed calls.

## Sub-skills

This skill is split into four focused workflows. Claude Code auto-discovers
them when this directory lives at `.claude/skills/pact-network/`.

| Sub-skill | Purpose |
|---|---|
| `pact-network-guide` | Overview, decision tree (which SDK), golden rule, troubleshooting |
| `pact-monitor` | `@pact-network/monitor` — wrap `fetch()`, sync signed batches, events |
| `pact-insurance` | `@pact-network/insurance` — on-chain policy, estimate, claims |
| `pact-integration` | Wire both SDKs together + Anthropic / Fastify / Express / Next.js patterns |

## Install

Clone or copy this directory into your project:

```
.claude/skills/pact-network/
├── pact-network-guide/SKILL.md
├── pact-monitor/SKILL.md
├── pact-insurance/SKILL.md
└── pact-integration/SKILL.md
```

Claude Code picks them up at session start. In-session, invoke by name:

```
/pact-monitor
/pact-insurance
/pact-integration
/pact-network-guide
```

Or just describe what you want and Claude will pick the right one.

## Source of Truth

The canonical copy lives in the `pact-monitor` monorepo at
`.claude/skills/pact-network/` — a sync workflow mirrors it to
`solder-build/pact-skill` on each release. Edit in the monorepo, not here.

## Links

- [Scorecard](https://pactnetwork.io)
- [Monorepo](https://github.com/solder-build/pact-monitor)
- [Monitor SDK](https://github.com/solder-build/pact-monitor/tree/main/packages/monitor)
- [Insurance SDK](https://github.com/solder-build/pact-monitor/tree/main/packages/insurance)
- [Samples](https://github.com/solder-build/pact-monitor/tree/main/samples)

## License

MIT
