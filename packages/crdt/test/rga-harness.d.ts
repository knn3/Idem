// Ambient types for the plain-JS oracle at docs/reference/rga-harness.mjs.
// It has no dependency on packages/crdt/src — see PLAN.md M1 and SPEC §3.
declare module '*/rga-harness.mjs' {
  export class Doc {
    constructor(replica: string);
    readonly items: readonly { readonly deleted: boolean }[];
    localInsert(visibleIndex: number, content: string): unknown;
    apply(op: unknown): boolean;
    toString(): string;
  }
}
