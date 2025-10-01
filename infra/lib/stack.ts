// infra/lib/stack.ts
import * as cdk from "aws-cdk-lib";

import type { Construct } from "constructs";

/**
 * Minimal, production-safe CDK stack that compiles and synthesizes cleanly.
 * Add real resources inside this constructor as you go (S3/CF/SES/etc).
 */
export class BowdoinMarketplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Harmless output so `cdk synth` always has at least one construct:
    new cdk.CfnOutput(this, "StackOk", { value: "ok" });
  }
}