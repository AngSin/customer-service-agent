import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseProtection } from "../scripts/release-guard.mjs";

test("CI release guard requires reviewers and an explicit main branch policy", () => {
  const environment = {
    protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
    deployment_branch_policy: { custom_branch_policies: true }
  };
  const policies = { branch_policies: [{ name: "main", type: "branch" }] };
  assert.doesNotThrow(() => validateReleaseProtection(environment, policies));
  assert.throws(
    () => validateReleaseProtection({}, policies),
    /required reviewers/
  );
  assert.throws(
    () =>
      validateReleaseProtection(
        {
          ...environment,
          protection_rules: [{ type: "required_reviewers", reviewers: [] }]
        },
        policies
      ),
    /required reviewers/
  );
  assert.throws(
    () =>
      validateReleaseProtection(environment, {
        branch_policies: [{ name: "main", type: "tag" }]
      }),
    /main branch/
  );
  assert.throws(
    () => validateReleaseProtection(environment, { branch_policies: [] }),
    /main branch/
  );
});
