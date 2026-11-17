// Header: the output plan, what of each email is printed, folded or left
// out. Shared types only, no code (README.md, "Where things are").
// thread-analysis/output-plan.ts (planOutput) makes it from the user's
// OutputPolicy; page-logic/, page/, pdf-export/ and the PDF worker use it.

/** What the PDF leaves out. */
export interface OutputPolicy
{
    /** Quoted history the mail app added below a reply (rule 2). */
    readonly appQuotedHistory: 'omit' | 'keep';
    /** 'none' leaves out every signature fold (outside forwarded parts). */
    readonly signatures: 'first-per-sender' | 'all' | 'none';
    /** True: keep everything (the "include everything unfolded" option). */
    readonly unfoldEverything: boolean;
}

/**
 * What a range of the body is (independent of the policy; `keep` holds the
 * policy's decision):
 * - 'text': not folded (always kept), a folded whitespace-only piece outside
 *   the tail, or own text found inside or below a quote (rule 2b);
 * - 'writer-quote': a folded quote that is not app quoted history (rule 2);
 * - 'forwarded': in the forwarded part (rule 1);
 * - 'app-quoted-history': folded, in the tail (rule 2);
 * - 'signature': a signature block, the first of its kind for this sender (or
 *   every one, with policy 'none');
 * - 'repeated-signature': a signature block already kept in an earlier email
 *   of the same sender.
 */
export type PlanReason = 'text' | 'writer-quote' | 'forwarded' | 'app-quoted-history' | 'signature' | 'repeated-signature';

/** Code units [start, end) of the body, kept or left out. */
export interface PlanRange
{
    readonly start: number;
    readonly end: number;
    readonly keep: boolean;
    readonly reason: PlanReason;
}

/** The plan of one email. */
export interface MessagePlan
{
    /** Contiguous cover of [0, bodyText.length); neighbours with the same keep and reason are merged. [] for an empty body. */
    readonly ranges: readonly PlanRange[];
    /** Where the app quoted history starts (rule 2), whatever the policy; null when there is none. */
    readonly tailStart: number | null;
    /** Signature blocks left out. */
    readonly omittedSignatures: number;
    /**
     * Rule 4: the policy would have left no non-whitespace text of this email,
     * so the whole body is kept instead (every range has keep: true, the
     * reasons still say what each part is).
     */
    readonly keptAllBecauseEmpty: boolean;
    /** The segments were invalid or a rule failed: the whole body is kept. */
    readonly fallback: boolean;
}
