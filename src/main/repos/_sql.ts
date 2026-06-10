// Shared repo SQL helpers: tolerant JSON column parsing and the partial-UPDATE SET-clause builder that
// every *.repo update() previously hand-rolled (sets/args accumulation). Pure helpers — no connection
// state here; repos keep owning their statements and column names.

export type SqlValue = string | number | null

// Tolerant JSON column → value: malformed/legacy content falls back instead of throwing mid-listing.
export function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

// Build a partial UPDATE's SET fragment from [column, value] pairs. A pair whose value is undefined is
// skipped (field not in the patch); null is a real value (SET col = NULL). Callers append WHERE args.
export function buildUpdate(pairs: Array<[column: string, value: SqlValue | undefined]>): {
  sets: string[]
  args: SqlValue[]
} {
  const sets: string[] = []
  const args: SqlValue[] = []
  for (const [column, value] of pairs) {
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    args.push(value)
  }
  return { sets, args }
}

// Patch-field mappers for buildUpdate pairs: keep undefined (= not patched) flowing through, transform
// everything else into its column representation.
export const asJson = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v))
export const asBool = (v: boolean | undefined): number | undefined => (v === undefined ? undefined : v ? 1 : 0)
