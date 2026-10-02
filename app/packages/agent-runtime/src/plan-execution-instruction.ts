import type { PlanExecution } from "@pi-desktop/shared";

/**
 * The internal prompt an approved Plan/Goal execution runs with.
 *
 * One implementation for both engines: the Pi runtime appends it to its
 * in-memory context without creating a visible user turn
 * (`runtime.executeApprovedPlan`), and the OMP bridge submits it through the
 * session's own prompt path — so the approved Markdown, the immutable host
 * artifact path and the approval question reach the executing model verbatim,
 * whichever runtime owns the session. Neither entry may substitute a summary
 * like "execute the plan above": the boundaries (exact snapshot, no
 * renegotiation, the criterion walk for Goal) are part of the contract.
 */
export function approvedPlanInstruction(execution: PlanExecution): string {
  const kind = execution.kind === "goal" ? "goal" : "plan";
  const lines =
    kind === "goal"
      ? [
          "The user approved the goal contract below. Reach that goal now, autonomously.",
          `Use the host-created goal artifact at the workspace-relative path: ${execution.artifact.relativePath}`,
          `Approved goal title: ${execution.title}`,
          `Approval question: ${execution.question}`,
          "Treat the following Markdown as the exact approved contract. Do not renegotiate it, replace it with a new contract, or ask for approval again.",
          "<approved-goal-markdown>",
          execution.plan,
          "</approved-goal-markdown>",
          "Choose your own approach with the normal Agent tools. Then verify every acceptance criterion yourself, running the checks the contract names rather than assuming they pass.",
          "Keep working while a criterion is still unmet and you have an untried approach. Stop early only if a boundary in the contract blocks you or a criterion cannot be verified; say which one and why.",
          "Finish with a report that walks the acceptance criteria one by one, each marked met or unmet with the evidence you observed.",
        ]
      : [
          "Execute the approved implementation plan now.",
          `Use the host-created plan artifact at the workspace-relative path: ${execution.artifact.relativePath}`,
          `Approved plan title: ${execution.title}`,
          `Approval question: ${execution.question}`,
          "Treat the following Markdown as the exact approved snapshot. Do not replace it with a new plan or ask for approval again.",
          "<approved-plan-markdown>",
          execution.plan,
          "</approved-plan-markdown>",
          "Implement the approved plan with the normal Agent tools, then report the result.",
        ];
  return lines.join("\n");
}
