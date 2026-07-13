# Apollo — Vision

Apollo is the execution layer of [Archic](https://github.com/vornicx): a local-first AI harness —
CLI and desktop — that squeezes the maximum out of every model, subscription, and API the user
configures, and turns AI-assisted work into something robust, verifiable, and precise.

Apollo exists because AI-generated work today feels like vibecoding: fast, plausible, and fragile.
Apollo's job is to make the output of AI work **trustworthy by construction**.

## Principles

1. **Every token in its right place.** The autorouter assigns work to models by specialization,
   quality, cost, and speed. The strongest reasoning model plans; the strongest coding model acts;
   trivial work goes to cheap or local models. Never burn a frontier model on a rename.
2. **Nothing ships unverified.** Every task runs a pipeline — plan → route → execute → verify.
   Failed verification triggers escalation to a stronger model, not a shrug. Robustness is a
   process property, not a prompt instruction.
3. **Explainable, always.** Every routing decision carries its full scoring breakdown and every
   elimination carries its reason. You can always answer "why this model, why now, what did it cost".
4. **Memory that endures.** Apollo remembers through [Midas](https://github.com/vornicx) —
   source-grounded, provenance-tracked, local, no LLM at ingest. Context compounds across sessions
   instead of evaporating.
5. **Total observability.** Everything the harness does is a typed event on a bus. The UI is a
   projection of that stream — you know what is happening at every moment, live and after the fact.
6. **Local-first.** Your keys, your machine, your data. Providers are interchangeable; the harness
   is yours.
7. **Purposeful interfaces.** Every surface, component, and section has one reason to exist. Clean,
   dense, premium — no decoration without function.

## What Apollo is not

- Not another chat wrapper. The unit of work is a *task with a verifiable outcome*, not a message.
- Not provider-locked. Anthropic, OpenAI, Google, local models — all first-class, all routed on merit.
- Not a demo. The bar is: what Apollo produces is usable, tested, and does not fail silently.

## North star

Apollo becomes the standard harness for producing software and work products with AI that are
robust by default — the place where "it was AI-generated" stops meaning "check it twice".
