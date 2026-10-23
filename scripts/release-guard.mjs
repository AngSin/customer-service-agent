import { pathToFileURL } from "node:url";

export function validateReleaseProtection(environment, policies) {
  if (
    !environment.protection_rules?.some(
      (rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0
    )
  )
    throw new Error(
      "The demo environment needs required reviewers before CI deployment."
    );
  if (
    !environment.deployment_branch_policy?.custom_branch_policies ||
    !policies.branch_policies?.some(
      (policy) => policy.name === "main" && policy.type === "branch"
    )
  )
    throw new Error(
      "The demo environment needs an explicit main branch deployment policy."
    );
}
async function main() {
  if (process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Deploy only from main.");
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token)
    throw new Error("GitHub deployment metadata is unavailable.");
  const base = `https://api.github.com/repos/${repository}/environments/demo`;
  const read = async (url) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok)
      throw new Error(
        `Cannot verify demo environment protection (${response.status}).`
      );
    return response.json();
  };
  validateReleaseProtection(
    await read(base),
    await read(`${base}/deployment-branch-policies`)
  );
  console.log("Required reviewers and main-branch deployment policy verified.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
