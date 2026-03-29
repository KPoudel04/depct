# depct

Give your stateless AI, runtime states

---

## The problem

Your AI coding agent reads your source code. It reads it really well. It reads it so well that when production breaks at 2am, it confidently generates a fix from static analysis alone.

The fix looks great. You deploy. Same error. Different line. Repeat.

Here's why: It's debugging blind. It can't read your server logs, it has no idea what's happening in prod without you telling it and sometimes you paste the wrong thing or not enough

depct gives your AI agent the one thing it's never had: **runtime state.**

## What it actually does

depct instruments your Node.js app with zero code changes. While your app runs, it captures:

- **Error causal chains**: The full call path from HTTP entry to crash site, with argument shapes at every hop
- **Argument shapes at failure**: The exact data structure that caused the error
- **Argument shapes at success**: What the data looks like when it *doesn't* break
- **The diff**: `zip: "number"` on failure vs `zip: "string"` on success. That's your bug. Right there.
- **Execution traces**: Full span trees with timing at every function call
- **Function profiles**: Invocation count, error rate, latency percentiles per function
- **Anomaly detection**: Error rate spikes, latency changes, traffic shifts vs historical baselines
- **External dependencies**: Health scores for every API, database, and cache your app talks to

Then with the CLI, your AI agents can figure out exactly what the problem is

## Quick start

One command. No config. No signup. Works with both **CommonJS** and **ESM** projects.

```bash
npm i depct2.0 -g
depct start -- <Your start command>
```

That's it. depct auto-initializes, instruments your app, writes a `CLAUDE.md` so your AI discovers the commands automatically, and starts capturing to a local SQLite database.

```

## What your AI gets

When your AI runs `depct errors --json`, it gets this:

```json
{
  "error_class": "TypeError",
  "message_template": "address.zip.startsWith is not a function",
  "trigger": {
    "function": "estimateDelivery",
    "file": "src/services/shipping-service.js",
    "line": 65
  },
  "causal_chain": [
    { "node_id": "src/routes/api.js:handleRequest:56", "args_shape": [] },
    { "node_id": "src/services/shipping-service.js:estimateDelivery:65", "args_shape": { "zip": "number" } }
  ],
  "shape_diff": {
    "status": "differs",
    "summary": "1 field(s) differ: zip",
    "field_diffs": [
      { "field": "zip", "on_failure": "number", "on_success": "string" }
    ]
  },
  "blast_radius": {
    "affected_endpoints": ["estimateDelivery"],
    "affected_traces": 12,
    "impact_pct": 14
  },
  "frequency": { "total": 12, "last_day": 5, "trend": "spiking" }
}
```

Your AI reads that and knows *exactly* what's wrong. `zip` is coming in as a number but the code calls `.startsWith()` which only works on strings.

Runtime errors being handled directly by the AI with no middle man pasting them in.

## Commands

Every command supports `--json` for AI consumption and works without flags after first run.

### Tools for AI

| Command | What it does |
|---|---|
| `depct errors` | Error groups with causal chains, arg shape diffs, blast radius |
| `depct trace <query>` | Execution traces with nested span trees and bottleneck detection |
| `depct inspect <function>` | Function deep dive — invocations, error rate, latency percentiles |
| `depct build-test` | Test candidates ranked by shape diff quality with reproduction context |
| `depct anomalies` | Behavioral anomalies — error rate spikes, latency changes vs baselines |
| `depct deps` | External dependencies (APIs, databases, caches) with health scores |

### System

| Command | What it does |
|---|---|
| `depct start` | Instrument and run your app. Auto-initializes everything on first run. |
| `depct status` | System health — error groups, traces, functions tracked |
| `depct doctor` | Diagnose setup issues |
| `depct init` | Explicitly initialize (usually not needed — start auto-inits) |

### Examples

```bash
# See what's broken
depct errors --json

# Execution traces for a function or endpoint
depct trace shipping --json
depct trace estimateDelivery --json

# Deep dive on a specific function
depct inspect createOrder --json

# Test candidates with reproduction context
depct build-test --json
depct build-test --json --limit 3

# Filter errors by time
depct errors --json --since 1h
depct errors --json --severity high

# Output to a file
depct errors --json > errors.json
depct build-test --json > test-candidates.json
```

## How it works

1. `depct start` wraps your Node.js process via `--require` (CJS) and `--import` (ESM). Your app runs normally. depct watches.
2. At runtime, it captures errors, argument shapes, execution traces, and call paths into a local SQLite database (`.depct/depct.db`). No data leaves your machine.
3. When an error fires, depct records the causal chain (every function in the call path with its argument shapes) and diffs it against successful calls to the same function.
4. The CLI queries that database and returns structured JSON. Your AI agent reasons over it. No external cost.

## AI agent integration

depct auto-creates a `CLAUDE.md` and `.cursorrules` on first run. Your AI agent reads these files and discovers the commands automatically. You don't configure anything.

If using anything other than Claude Code or Cursor, you might have to write a config file yourself or submit a feature request!

Next time you ask Claude Code "why is checkout failing?", it runs `depct errors --json` on its own.

## What depct solves

You can't remember that Stripe calls are 3x slower on Tuesdays, you have to observe it. You can't "cache" a function's runtime call graph, you have to capture it live. You have no idea about runtime errors until your users complain, and then you're stuck looking at server logs...

depct is built for AI agents to solve this problem, a sort of runtime debugger by giving it data it can't get anywhere else

## Requirements

- Node.js >= 20
- Works with both CommonJS (`require`) and ESM (`import`) projects
- Zero native dependencies

## License

MIT
