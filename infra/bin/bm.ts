// infra/bin/bm.ts

/* eslint-env node */
/* eslint-disable import/no-extraneous-dependencies */

import process from "node:process";

import * as cdk from "aws-cdk-lib";

// IMPORTANT (NodeNext ESM):
// - At runtime we import the built extension ".js"
// - TypeScript will still type this from ../lib/stack.ts
import { BowdoinMarketplaceStack } from "../lib/stack.js";

/** Strongly-typed view of the context you put in cdk.json */
type Ctx = {
  enableCloudFront?: boolean;
  rootDomain?: string;
  appSubdomain?: string; // "" = apex
  region?: string;
};

const app = new cdk.App();

/* ------------------------------ helpers ------------------------------ */

function getCtx(): Required<Ctx> {
  const enableCloudFront =
    (app.node.tryGetContext("enableCloudFront") as boolean | undefined) ?? true;
  const rootDomain = (app.node.tryGetContext("rootDomain") as string | undefined) ?? "";
  const appSubdomain = (app.node.tryGetContext("appSubdomain") as string | undefined) ?? "";
  const region =
    (app.node.tryGetContext("region") as string | undefined) ??
    process.env.CDK_DEFAULT_REGION ??
    "us-east-1";

  return { enableCloudFront, rootDomain, appSubdomain, region };
}

/** Cheap stage detector: STAGE > NODE_ENV > default 'dev' */
function detectStage(): "prod" | "staging" | "dev" {
  const s = (process.env.STAGE ?? process.env.NODE_ENV ?? "dev").toLowerCase();
  if (s.startsWith("prod")) return "prod";
  if (s.startsWith("stag")) return "staging";
  return "dev";
}

/** Soft validation + friendly hints without throwing the world */
function assertConfig(ctx: Required<Ctx>) {
  if (!ctx.rootDomain) {
    // eslint-disable-next-line no-console
    globalThis.console.warn(
      "[infra] WARNING: `rootDomain` is empty in cdk.json context; DNS/SES pieces may be skipped.",
    );
  }
}

/* ------------------------------ main ------------------------------ */

const ctx = getCtx();
assertConfig(ctx);

const account =
  process.env.CDK_DEFAULT_ACCOUNT ??
  process.env.AWS_ACCOUNT_ID ??
  undefined;

if (!account) {
  throw new Error(
    "CDK_DEFAULT_ACCOUNT is not set. Configure AWS credentials/profile, " +
      "or export AWS_ACCOUNT_ID. Then run `pnpm cdk bootstrap`.",
  );
}

const region = ctx.region;
const stage = detectStage();
const isProd = stage === "prod";

// Human-friendly stack id & description
const stackId = `BowdoinMarketplace-${stage}`;
const description =
  "Bowdoin Marketplace infrastructure (S3/CloudFront, SES/MAIL FROM, SSM params, etc.). Managed by AWS CDK.";

// Create the stack
const stack = new BowdoinMarketplaceStack(app, stackId, {
  env: { account, region },
  description,
  terminationProtection: isProd,
});

// Global tags
const tags: Record<string, string | undefined> = {
  Project: "BowdoinMarketplace",
  Stage: stage,
  Owner: process.env.INFRA_OWNER ?? "adam",
  ManagedBy: "cdk",
  Repository: process.env.CI_REPO ?? "github.com/azaatar/bowdoin-marketplace-clean",
  Commit: process.env.CI_COMMIT ?? process.env.GIT_COMMIT,
  RootDomain: ctx.rootDomain || undefined,
  AppDomain: ctx.appSubdomain ? `${ctx.appSubdomain}.${ctx.rootDomain}` : ctx.rootDomain || undefined,
};
Object.entries(tags).forEach(([k, v]) => {
  if (v) cdk.Tags.of(stack).add(k, v);
});

// Synth-time summary
new cdk.CfnOutput(stack, "InfraSummary", {
  value: JSON.stringify(
    {
      stage,
      account,
      region,
      rootDomain: ctx.rootDomain || "(none)",
      appDomain: ctx.appSubdomain
        ? `${ctx.appSubdomain}.${ctx.rootDomain}`
        : ctx.rootDomain || "(none)",
      enableCloudFront: ctx.enableCloudFront,
    },
    null,
    2,
  ),
  description: "High-level view of the selected deployment context.",
});