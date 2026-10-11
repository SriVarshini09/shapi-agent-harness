# SHAPI Agent Harness

One-screen hackathon prototype: a Task Agent upgrades Maya to Pro, a broken provider returns `200 OK` without granting access, and SHAPI checks customer state independently. A Policy Proposer uses retrieved incidents to suggest a bounded policy change. Deterministic replay decides whether it can be promoted.

## What evolves

| Version | Harness behavior | Origin |
| --- | --- | --- |
| v0 | Trust the upgrade response | Engineered baseline |
| v1 | Independently verify payment and entitlement | Engineered |
| v2 | Retrieve similar incidents from Atlas memory | Engineered |
| v3 | Verify, reconcile at most once, verify again, or escalate | Model-proposed, replay-gated |

The two model-driven roles are Task Agent and Policy Proposer. The verifier, Vector Search query, 18-case replay, and promotion gate are ordinary code. This is harness-policy improvement, **not** model fine-tuning or autonomous code editing. Payments are simulated; no Stripe account or real charge is involved.

## Quick local development run

Requires Node.js 20+ and pnpm. From this directory:

```powershell
pnpm install
pnpm test
pnpm build
$env:DEMO_STORAGE = 'memory'
pnpm start
```

Open `http://localhost:3007`. Click **Break Provider**, then **Upgrade Maya**. This mode uses an in-process store, lexical memory lookup, and explicitly labeled simulated agents. It exercises the UI and control flow, **but is not a valid Atlas/OpenAI judging run**. The memory disappears on restart.

## Live Atlas + OpenAI setup

1. Create an Atlas cluster, database user, and network access rule. Save its connection string as `MONGODB_URI`. Keep credentials out of Git. Atlas must support Vector Search and Automated Embedding with `voyage-4`.
2. Set an OpenAI API key as `OPENAI_API_KEY`. The default model is `gpt-6-luna`; override with `OPENAI_MODEL` only if deliberately changing the demo model. OpenAI's model page lists the Free API tier as unsupported for `gpt-6-luna`, so confirm your API project has model access before judging.
3. Copy `.env.example` to `.env` and fill the values. Do **not** set `DEMO_STORAGE=memory` for live judging.
4. Run `pnpm setup:atlas`. It creates collection indexes, three clearly labeled simulated prior episodes, and the `episode_memory_voyage4` Vector Search index. The index may take time to become queryable; rerun the command to check status.
5. Run `pnpm verify:live`. It must prove Atlas read/write, a seeded Vector Search hit, and a real `gpt-6-luna` structured Responses call. Then run `pnpm build` and `pnpm start`. Visit `/api/ready` and require `database: true`, `memoryIndex: true`, `storage: "atlas"`, `agents: "openai"`, and `liveReady: true` before the demo. The HTTP readiness call alone does not test whether the OpenAI key works.

The server writes `shapi_harness` collections: `demo_sessions`, `customers`, `payments`, `runs`, `episodes`, `policies`, `eval_runs`, and a `readiness` canary. The `payments.idempotencyKey` index is unique. Runs, policy versions, evals, and episodes persist across server restarts.

The live demo makes real OpenAI Responses API calls. It uses function calls for the Task Agent and a schema-constrained JSON proposal for the Policy Proposer. Every candidate records the returned model ID and the prompt. Atlas Vector Search with Voyage-backed Automated Embedding supplies the prior incidents. The live path performs one memory retrieval per demo run.

## Judge flow

1. **Break Provider** selects a silent-failure fault for this browser session.
2. **Upgrade Maya** runs v0. Its upgrade call returns `200 OK`, but the independent customer read shows Pro inactive. The event and episode are stored.
3. v2 retrieves prior simulated incidents. The proposer can submit one candidate and, if replay rejects it, revise once using counterexamples.
4. The promotion gate runs 18 deterministic fixtures across normal success, silent `200`, delayed access, malformed responses, duplicate requests, and provider drift. All must pass; zero false-success claims and duplicate charges are allowed. Evals do not call the model.
5. If v3 is promoted, the Task Agent repeats the same customer request. The payment is reused via idempotency, the entitlement is checked, reconciliation is allowed once after a failed check, and success requires a final independent verification.
6. **Inspect Atlas Evidence** opens the stored run, episode, policy candidates, eval results, and active version. In local mode the button says **Inspect Local Evidence**.

The UI streams real server events; it does not animate a predetermined success score. Runtime depends on Atlas and model latency, so rehearse before presenting.

## Commands

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm setup:atlas
pnpm verify:live
pnpm start
```

`pnpm dev` runs the API and Vite separately for development; run `pnpm build` once first so the API has a static fallback directory. The production `pnpm start` server serves both the API and built React page on `PORT` (default 3007).

## Deployment and event checklist

Render deployment is not automatic. This directory needs a Git remote pushed to GitHub/GitLab/Bitbucket, Atlas credentials/network access, and an OpenAI key before a hosted service can work. Deploy as one Node web service with build command `pnpm install --frozen-lockfile && pnpm build`, start command `pnpm start`, health check `/api/ready`, and environment variables `MONGODB_URI`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna`, `DEMO_STORAGE=atlas`, and `NODE_ENV=production`. Run `pnpm setup:atlas` before judging. Avoid an unrestricted public link without abuse/cost controls because each run invokes a paid model.

At event check-in, confirm the actual submission deadline, format, judging criteria, and whether pre-existing SHAPI concepts/code are permitted. The public event brief did not state all of these. Disclose prior SHAPI inspiration and distinguish newly built side-project code from reused material.
