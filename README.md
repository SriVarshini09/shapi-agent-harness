# SHAPI Agent Harness

One-screen hackathon prototype: a Task Agent upgrades Maya to Pro, a broken provider returns `200 OK` without granting access, and SHAPI checks customer state independently. A Policy Proposer uses retrieved incidents to suggest a bounded policy change. Deterministic replay decides whether it can be promoted.

## What evolves

| Version | Harness behavior | Origin |
| --- | --- | --- |
| v0 | Trust the upgrade response | Engineered baseline |
| v1 | Independently verify payment and entitlement | Engineered |
| v2 | Retrieve similar incidents from Atlas memory | Engineered |
| v3 | Verify, reconcile at most once, verify again, or escalate | Model-proposed, replay-gated |

The two model-driven roles are Task Agent and Policy Proposer. The verifier, Vector Search query, 18-case replay, and promotion gate are ordinary code. This is harness-policy improvement, **not** model fine-tuning or autonomous code editing. Maya and the entitlement provider are fictional. Payment uses a simulator unless a Stripe **test-mode** secret key is configured; even then, no money moves.

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

1. Create an Atlas cluster, database user, and network access rule. Save its connection string as `MONGODB_URI`. Keep credentials out of Git. Atlas must support Vector Search and Automated Embedding with `voyage-4`. On a dedicated `M10+` cluster, enable **storage auto-scaling** before creating the automated embedding index; MongoDB requires it. The Atlas overview's generic **Auto-scaling** status is not proof of the storage setting, so check the cluster's Edit configuration.
2. Set an OpenAI API key as `OPENAI_API_KEY`. The default model is `gpt-6-luna`; override with `OPENAI_MODEL` only if deliberately changing the demo model. OpenAI's model page lists the Free API tier as unsupported for `gpt-6-luna`, so confirm your API project has model access before judging.
3. Copy `.env.example` to `.env` and fill the values. Do **not** set `DEMO_STORAGE=memory` for live judging.
4. Run `pnpm setup:atlas`. It creates collection indexes, three clearly labeled simulated prior episodes, and the `episode_memory_voyage4` Vector Search index. The index may take time to become queryable; rerun the command to check status.
5. Run `pnpm verify:live`. It must prove Atlas read/write, a seeded Vector Search hit, and a real `gpt-6-luna` structured Responses call. Then run `pnpm build` and `pnpm start`. Visit `/api/ready` and require `database: true`, `memoryIndex: true`, `storage: "atlas"`, `agents: "openai"`, and `liveReady: true` before the demo. The HTTP readiness call alone does not test whether the OpenAI key works.

The server writes `shapi_harness` collections: `demo_sessions`, `customers`, `payments`, `runs`, `episodes`, `policies`, `eval_runs`, and a `readiness` canary. The `payments.idempotencyKey` index is unique. Runs, policy versions, evals, and episodes persist across server restarts.

The live demo makes real OpenAI Responses API calls. It uses function calls for the Task Agent and a schema-constrained JSON proposal for the Policy Proposer. Every candidate records the returned model ID and the prompt. Atlas Vector Search with Voyage-backed Automated Embedding supplies the prior incidents. The live path performs one memory retrieval per demo run.

## Optional real Stripe API, test mode only

Set `STRIPE_SECRET_KEY=sk_test_...` in the server-side `.env` and restart. The app refuses `sk_live_` keys. A new demo session creates one real Stripe test-mode PaymentIntent for $5.00 USD using Stripe's `pm_card_visa` test PaymentMethod, then saves its `pi_...` ID in Atlas. The same payment is retrieved and checked with Stripe before each upgrade, verification, and reconciliation. v1–v3 reuse that PaymentIntent rather than creating another. The fault remains in the fictional entitlement provider: it returns `200 OK` without enabling Pro access. Stripe test mode is an actual Stripe API integration but **not a real-money payment or production customer upgrade**. The 18 replay fixtures remain deterministic simulations, not 18 Stripe calls. Stripe's test values and idempotency behavior are documented in its [testing guide](https://docs.stripe.com/testing) and [API reference](https://docs.stripe.com/api/idempotent_requests).

`/api/ready` and the page identify `paymentProvider` as `stripe-test` or `simulated`. Never claim the Stripe integration is live until the test key is configured and a run's Atlas evidence contains a `pi_...` payment ID with `provider: "stripe-test"`. The secret key must never be committed or entered in the browser.

## Optional Raindrop outcome monitoring

Add `RAINDROP_WRITE_KEY` to the server's local `.env` (and optionally `RAINDROP_PROJECT_ID` for a non-default project). Never put the write key in browser code or Git. Restart the server after changing `.env`. `/api/ready` reports `raindropConfigured: true` when the SDK is enabled; this does **not** prove that Raindrop accepted an event. Run the demo and check the Raindrop outcome indicator and `raindrop-recorded` events in Atlas evidence, then confirm both interactions and their signals in the Raindrop project before claiming the partner integration in a submission.

The server sends one interaction for each live harness version: `v0` false success, `v1` and `v2` safe escalation, and `v3` verified recovery. Each uses the Atlas run ID as conversation ID, an opaque session ID as user ID, sanitized tool results, and a `false_success`, `verified_recovery`, or `safe_escalation` signal. Customer names, email addresses, payment IDs, raw prompts, and credentials are not sent. Raindrop is observational; Atlas remains the source of truth and telemetry failure never changes replay or promotion decisions.

## Judge flow

1. **Break Provider** selects a silent-failure fault for this browser session. The new on-screen fault panel names the exact target: the simulated `upgrade_customer` provider returns `200 OK` but skips the Pro-entitlement write. Stripe test payment is not broken. The panel distinguishes an armed fault from an observed mismatch.
2. **Upgrade Maya** runs the Task Agent with v0. Its upgrade call returns `200 OK`, but the independent customer read shows Pro inactive. The event and episode are stored.
3. The page scrolls to a live v0→v3 evolution ladder as the run starts. The same model and request run with v1: it verifies and safely escalates. Atlas then retrieves prior simulated incidents; v2 receives them as context and also safely escalates because it still cannot reconcile. Each ladder card shows the harness change, engineered/model-proposed origin, running state, live claim and customer access, and separately measured replay score. The four-version comparison below shows tool sequence, payment reuse, and memory hits.
4. The proposer can submit one candidate and, if replay rejects it, revise once using counterexamples.
5. The promotion gate runs 18 deterministic fixtures across normal success, silent `200`, delayed access, malformed responses, duplicate requests, and provider drift. All must pass, with zero false-success claims and zero duplicate charges. Evals do not call the model.
6. If v3 is promoted, the Task Agent repeats the same customer request. The payment is reused via idempotency, the entitlement is checked, reconciliation is allowed once after a failed check, and success requires a final independent verification.
7. **Inspect Atlas Evidence** opens the stored run, all four agent outcomes, payment provider and ID, episode, policy candidates, eval results, and active version. In local mode the button says **Inspect Local Evidence**.

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

Render deployment is not automatic. This directory needs a Git remote pushed to GitHub/GitLab/Bitbucket, Atlas credentials/network access, and an OpenAI key before a hosted service can work. Deploy as one Node web service with build command `pnpm install --frozen-lockfile && pnpm build`, start command `pnpm start`, health check `/api/ready`, and environment variables `MONGODB_URI`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna`, `DEMO_STORAGE=atlas`, and `NODE_ENV=production`. Add `RAINDROP_WRITE_KEY` and optional `RAINDROP_PROJECT_ID` only after validating Raindrop delivery. Add `STRIPE_SECRET_KEY` only if the test-mode flow has been verified. Run `pnpm setup:atlas` before judging. Avoid an unrestricted public link without abuse/cost controls because each run invokes a paid model and, with Stripe enabled, a Stripe test API call.

At event check-in, confirm the actual submission deadline, format, judging criteria, and whether pre-existing SHAPI concepts/code are permitted. The public event brief did not state all of these. Disclose prior SHAPI inspiration and distinguish newly built side-project code from reused material.
