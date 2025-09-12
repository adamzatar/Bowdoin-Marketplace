declare module '@bowdoin/auth/utils/email-token-store' {
  export type IssueOptions = {
    userId: string;
    email: string;
    ttlSeconds?: number;
  };

  export type IssueResult = {
    token: string;
    expiresAt: Date | number | string;
  };

  export class EmailTokenStore {
    create(opts: IssueOptions): Promise<IssueResult>;
    issue?(opts: IssueOptions): Promise<IssueResult>; // tolerate older name
  }
}