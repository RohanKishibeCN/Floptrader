/**
 * The one hash this process uses to name a message body.
 *
 * The room echoes a message's `text` back verbatim, so hashing the body — rather
 * than the whole envelope — gives a value both sides can re-derive. That is what
 * makes "is this echo ours?" and "which seed are we running on?" answerable
 * instead of assumed.
 */
import { createHash } from 'node:crypto';

/** `sha256:<hex>` over `text`, UTF-8. */
export function messageHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
