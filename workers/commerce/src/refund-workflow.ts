import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  finalizeAttempt,
  loadAttempt,
  markAttention,
  processAttempt,
  reconcileAttempt,
  type RefundParams
} from "../../../shared/refunds";

export class RefundWorkflow extends WorkflowEntrypoint<
  CommerceEnv,
  RefundParams
> {
  async run(event: WorkflowEvent<RefundParams>, step: WorkflowStep) {
    if (event.payload.workflowId !== event.instanceId)
      throw new NonRetryableError("Invalid refund trigger");
    const id = event.instanceId;
    const config = {
      retries: {
        limit: 3,
        delay: "1 second" as const,
        backoff: "exponential" as const
      },
      timeout: "30 seconds" as const
    };
    try {
      const validated = await step.do(
        "validate accepted attempt",
        config,
        async () => {
          const a = await loadAttempt(this.env.DB, id);
          return { status: a.status };
        }
      );
      if (validated.status !== "pending") return { status: validated.status };
      let outcome = await step.do("execute same processor key", config, () =>
        processAttempt(this.env.DB, id)
      );
      for (let round = 0; outcome === "unknown" && round < 4; round++) {
        await step.sleep(
          `reconciliation wait ${round}`,
          `${2 ** round} seconds`
        );
        outcome = await step.do(`reconcile same attempt ${round}`, config, () =>
          reconcileAttempt(this.env.DB, id)
        );
      }
      if (outcome === "unknown") {
        await step.do("record unknown needs attention", config, () =>
          markAttention(this.env.DB, id)
        );
        return { status: "pending", needs_attention: true };
      }
      const status = await step.do("finalize confirmed outcome", config, () =>
        finalizeAttempt(this.env.DB, id)
      );
      return { status };
    } catch {
      // Exhausted technical retries never authorize another attempt or imply no money moved.
      await step.do("record exhausted retries", config, () =>
        markAttention(this.env.DB, id)
      );
      const current = await step.do(
        "read recovery status",
        config,
        async () => {
          const a = await loadAttempt(this.env.DB, id);
          return {
            status: a.status,
            needs_attention: Boolean(a.needs_attention)
          };
        }
      );
      return current;
    }
  }
}
