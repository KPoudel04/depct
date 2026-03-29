# depct

Give your statless AI, runtime states

---

## The problem

Your AI coding agent reads your source code. It reads it really well. It reads it so well that when production breaks at 2am, it confidently generates a fix from static analysis alone.

The fix looks great. You deploy. Same error. Different line. Repeat.

Here's why: It's debugging blind. It can't read your server logs, it has no idea what's happening in prod without you telling it and sometimes you paste the wrong thing or not enough

depct gives your AI agent the one thing it's never had: **runtime state.**

## What it actually does

depct instruments your Node.js app with zero code changes. While your app runs, it captures:

- **Error causal chains** — the full call path from HTTP entry to crash site, not just a stack trace
- **Argument shapes at failure** — the exact data structure that caused the error
- **Argument shapes at success** — what the data looks like when it *doesn't* break
- **The diff** — `defaultSource: "null"` on failure vs `defaultSource: {id, brand, last4}` on success. That's your bug. Right there.

Then with the CLI, your AI agents can figure out exactly what the problem is even though it should be working fine looking at the static code

## Quick start

One command. No config. No signup.

```bash
npx depct start -- node server.js
```

That's it. depct auto-initializes, instruments your app, writes a `CLAUDE.md` so your AI discovers the commands automatically, and starts capturing to a local SQLite database.

## What your AI gets

When your AI runs `depct errors --json`, it gets this:

```json
{
  "error_class": "TypeError",
  "message_template": "Cannot read properties of null (reading 'defaultSource')",
  "severity": "critical",
  "trigger": {
    "function": "resolvePaymentMethod",
    "file": "src/services/payment-service.js",
    "line": 31
  },
  "causal_chain": [
    { "node_id": "src/routes/orders.js:checkout:96", "args_shape": {"orderId": "string"} },
    { "node_id": "src/services/order-service.js:processOrder:191", "args_shape": "string" },
    { "node_id": "src/services/payment-service.js:resolvePaymentMethod:31", "args_shape": {"id": "string", "defaultSource": "null"} }
  ],
  "shape_diff": {
    "status": "differs",
    "summary": "2 field(s) differ: defaultSource, address",
    "field_diffs": [
      { "field": "defaultSource", "on_failure": "null", "on_success": {"id": "string", "brand": "string", "last4": "string"} }
    ]
  },
  "blast_radius": {
    "affected_endpoints": ["checkout"],
    "affected_traces": 19,
    "impact_pct": 14
  },
  "frequency": { "total": 247, "last_day": 19, "trend": "spiking" }
}
```

Your AI reads that and knows *exactly* what's wrong. `defaultSource` is `null` for customers without a saved payment method and that's causing bugs.

Compare that to what your AI gets without depct: a stack trace and vibes.

## Commands

Every command supports `--json` for AI consumption and works without flags after first run.

| Command | What it does |
|---|---|
| `depct errors` | Error groups with causal chains, shape diffs, blast radius |
| `depct build-test` | Test candidates ranked by how useful the shape diff is to an AI |
| `depct trace <endpoint>` | Full execution trace with timing at every function hop |
| `depct inspect <function>` | Deep dive on a specific function's behavior |
| `depct status` | System health overview |
| `depct doctor` | Diagnose setup issues |

Output to a file:

```bash
depct errors --json > errors.json
depct build-test --json > test-candidates.json
```

## How it works

1. `depct start` wraps your Node.js process via `--require`. Your app runs normally. depct watches.
2. At runtime, it captures errors, argument shapes, and call paths into a local SQLite database (`.depct/depct.db`). No data leaves your machine.
3. When an error fires, depct records the causal chain (every function in the call path with its argument shapes) and diffs it against successful calls to the same function.
4. The CLI queries that database and returns structured JSON. Your AI agent reasons over it. No external cost.

## AI agent integration

depct auto-creates a `CLAUDE.md` and `.cursorrules` on first run. Your AI agent reads these files and discovers the commands automatically. You don't configure anything.

If using anything other then Claude Code or Cursor, you might have to write a configure file yourself or submit a feature request!

Next time you ask Claude Code "why is checkout failing?", it runs `depct errors --json` on its own.

## What depct solves

You can't "remember" that Stripe calls are 3x slower on Tuesdays, you have to observe it. You can't "cache" a function's runtime call graph, you have to capture it live. You have no idea about runtime errors until your users complain, and then you're stuck looking at server logs...

depct is built for AI agents to solve this problem, a sort of runtime debugger by giving it data it can't get anywhere else


## Requirements

- Node.js >= 20
- Works with both CommonJS and ESM projects

## License

MIT
