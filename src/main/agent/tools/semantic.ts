// Model-tolerant scalar schemas. Tool inputs arrive as model-generated JSON and the model occasionally QUOTES
// scalars — {"offset":"30"} / {"replace_all":"false"} — which a bare z.number()/z.boolean() rejects
// with a hard type error, failing the whole tool call. These preprocess ONLY valid numeric / boolean
// string literals (NOT z.coerce, which would convert "" / null / JS-truthiness and mask real bugs);
// anything else falls through to the inner schema and is rejected there.
//
// z.preprocess still emits {"type":"number"|"boolean"} into the API tool schema, so the model is told
// the real type — the string tolerance is invisible client-side coercion, not an advertised shape.
//
// .optional()/.default() go INSIDE the inner schema, never chained after the wrapper (chaining onto a
// ZodPipe widens z.output<> to unknown in Zod v4):
//   semanticNumber()                        → number
//   semanticNumber(z.number().optional())   → number | undefined
//   semanticBoolean(z.boolean().default(false)) → boolean
import { z } from 'zod'

export function semanticNumber<T extends z.ZodType>(inner: T = z.number() as unknown as T) {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner)
}

export function semanticBoolean<T extends z.ZodType>(inner: T = z.boolean() as unknown as T) {
  return z.preprocess((v: unknown) => (v === 'true' ? true : v === 'false' ? false : v), inner)
}
