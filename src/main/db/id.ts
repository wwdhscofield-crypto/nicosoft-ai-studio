import { monotonicFactory } from 'ulid'

// Monotonic ULID generator. Within the same millisecond, ids strictly increase, so lexicographic id
// order always equals creation order — message ordering and summary covered_up_to boundary slicing
// rely on this. Single main process, so one module-level factory is enough (no cross-process
// coordination). Use this everywhere instead of the bare `ulid()` so ids are globally monotonic.
export const ulid = monotonicFactory()
