# Von integration

Von is the classifier in the intended AUTO routing architecture. It classifies the task among available user-configured models; pi-router follows the selected target and switches Pi's active provider/model. Von does not execute tasks.

## Candidate construction

`targets.ts` loads the target list from `PI_ROUTER_CONFIG` or `router.config.json`. `index.ts` resolves each target through Pi's model registry and excludes targets missing a model or configured authentication. Uppercase aliases become Von option names; descriptions become criteria. The same provider can have several models, and different providers can appear in one list.

For example, a request can contain:

```json
{
  "model": "von-latest",
  "state": {
    "task": "Implement a pagination endpoint",
    "phase": "normal",
    "attempts": 1,
    "toolErrors": 0,
    "testFailures": 0,
    "filesChanged": 0,
    "securitySensitive": false,
    "currentModel": "LUNA"
  },
  "questions": {
    "routing": {
      "type": "choice",
      "instructions": "Choose which model should undertake the task using candidate descriptions.",
      "options": ["LUNA", "SOL", "ASTRA"],
      "criteria": {
        "LUNA": "Quick, simple work",
        "SOL": "General coding and implementation",
        "ASTRA": "Difficult architecture and reasoning"
      }
    }
  }
}
```

The real adapter supplies its shared routing instruction and posts to `/v1/systemone`. Responses must contain a known choice and finite probabilities between 0 and 1 for exactly the offered options. Malformed responses, timeouts, and HTTP errors return no decision and block AUTO task execution.

## Policy and switching

1. New sessions start in AUTO. Every submitted AUTO task calls Von with its description and available targets; previous task decisions are not reused for new submissions.
2. Validate that `choice` names an offered target and that its response has finite probabilities for those candidates. Use Von's `choice` exactly. Probability, confidence, and failure counts never override a valid choice.
3. Resolve the alias to its full Pi registry model and await `setModel`. Commit routing state only if Pi accepts the switch.
4. If Von is disabled, unreachable, invalid, or timed out, or the chosen model cannot be selected, consume the input and show `AUTO blocked`. Do not start an agent run on a default or previously selected model. Direct/custom run triggers are also gated before starting, and unclassified turns are aborted.
5. In manual modes, `/<id>` (for example `/local`, `/astra`, `/sol`) pins the model and bypasses Von for every task. `/router <id>` and Pi's model selector provide equivalent manual selection. Failures do not change a manual choice. `/auto` resumes mandatory Von classification.

The old `clearChoiceThreshold`, `clearAstraThreshold`, `defaultTarget`, and `reasoningTarget` settings are ignored. Probabilities and confidence are diagnostic metadata supplied by Von. There is no deterministic or keyword fallback in AUTO. User-selected manual modes remain usable even when Von is disabled or offline.

New inputs received while a run is busy are classified before queueing; the selected model is applied at a safe turn boundary. A failed classification consumes only the new input. Only one AUTO task may wait at a time; an additional submission is rejected before it can overwrite the pending decision. Manual changes made while classification is in flight take precedence. Active tool turns may continue on the model already selected for that task; an agent end clears that authorization.

The Von configuration is read from `PI_ROUTER_VON_CONFIG` or `von.config.json` using an actual URL object for the default file. Custom per-option criteria can override target descriptions.

## Validation

`npm test` exercises target validation, four-model and multi-provider routing, manual pinning, unavailable candidates, mandatory-Von gating, disabled/offline/manual modes, failed switches, direct decision authority, and the real HTTP adapter against a deterministic local fixture. It also checks the original LOCAL/ASTRA defaults.

`npm run test:routing` runs the routing-only suite, ending at the selected model without task-model API keys or provider requests. Its complete HTTP pipeline test uses a local classifier fixture. `npm run test:von` exercises the same boundary against a real, warmed Von server, still with no task-model keys. It explicitly enables AUTO and checks that the selected provider/model matches Von's `choice` exactly. An absent classifier decision fails the check.

These tests do not prove real model classification quality. For deployment, load Von's actual weights, make real classification requests for representative tasks, warm the model, and verify responses fit the configured timeout. Then verify Pi can execute requests through each intended provider/model. `/health` alone is insufficient.

Historical binary LOCAL/ASTRA measurements do not establish classification quality for a configurable multi-model set. Candidate descriptions and classification quality should be evaluated with your workload.

## Observed live classification

With Von SDK 1.3.7, its von-1.3.0 weights, and the four descriptions in the test harness, the live smoke check returned:

| Task                                      | LOCAL  | LUNA   | SOL    | ASTRA  | Selected |
| ----------------------------------------- | ------ | ------ | ------ | ------ | -------- |
| Fix a typo in the documentation           | 0.5522 | 0.3603 | 0.0686 | 0.0190 | local    |
| Implement a pagination endpoint           | 0.4502 | 0.2941 | 0.1843 | 0.0713 | local    |
| Design a distributed authorization system | 0.4347 | 0.2210 | 0.2289 | 0.1154 | local    |

These are real classifier outputs, without task-provider calls. The highest-probability candidate was LOCAL in all three cases. The test passing establishes HTTP, parsing, policy, and model-selection integration; it does not establish useful separation between task categories. In particular, the architecture sample did not favor ASTRA. Task-specific classification quality needs separately labeled evaluation before relying on this configuration for production routing.

## High-intelligence task evaluation

Run `npm run test:von:hard` against a real, warmed Von service. The eight task descriptions are checked in at `tests/fixtures/high-intelligence-tasks.json`. ASTRA is the expected target because its configured description covers difficult architecture, deep reasoning, security analysis, and persistent failures. The evaluation uses four candidates with unchanged descriptions and passes each valid Von `choice` directly to model selection. Every case explicitly enables AUTO and checks that it is active before submitting the task. The fixture Pi registry exposes all four candidates, so missing task-provider credentials do not filter any out. No task-provider APIs are contacted.

| Task                                     | LOCAL  | LUNA   | SOL    | ASTRA  | Von choice | Router target |
| ---------------------------------------- | ------ | ------ | ------ | ------ | ---------- | ------------- |
| Consensus reconfiguration proof          | 0.3289 | 0.1701 | 0.2289 | 0.2721 | LOCAL      | local         |
| Cryptographic protocol/key rotation      | 0.2414 | 0.1574 | 0.2204 | 0.3808 | ASTRA      | astra         |
| Weak-memory concurrency correctness      | 0.3506 | 0.2352 | 0.2262 | 0.1880 | LOCAL      | local         |
| Byzantine finality/quorum analysis       | 0.3453 | 0.2204 | 0.1942 | 0.2401 | LOCAL      | local         |
| Causal identification/hidden confounding | 0.3706 | 0.2357 | 0.2063 | 0.1874 | LOCAL      | local         |
| Stiff numerical solver stability         | 0.3534 | 0.2210 | 0.2477 | 0.1779 | LOCAL      | local         |
| Cross-layer production failure           | 0.2792 | 0.2457 | 0.2433 | 0.2319 | LOCAL      | local         |
| Authorization noninterference proof      | 0.3502 | 0.2044 | 0.2389 | 0.2065 | LOCAL      | local         |

**Result after removing router overrides: 1/8 cases selected the expected ASTRA target; 8/8 model selections matched Von's choice exactly.** The cryptographic task now selects ASTRA at its reported 0.3808 probability. Seven capability-tier assertions still fail because Von selects LOCAL for those tasks; Node reports eight failed tests including the parent and one passed subtest. HTTP requests, response parsing, and model switches completed without task-provider calls.

The previous router-side 0.6 threshold overrode the cryptographic ASTRA choice with LOCAL. That override is removed. The remaining seven unexpected LOCAL selections originate in the classifier output and need separate candidate-description/model-quality evaluation. These findings do not establish that Von reliably distinguishes the highest-capability tasks.

Longer descriptions took about 1–2 seconds on this CPU. The bundled and retained local runtime timeouts are now 5 seconds; the live-test timeout defaults to 15 seconds. The earlier 800 ms timeout was shorter than the observed inference time for these cases.
