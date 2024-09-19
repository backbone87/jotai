export interface UntrackedResource<T> extends PromiseLike<T> {
  status?: undefined
  sync?: true
}

export interface PendingResource<T> extends PromiseLike<T> {
  status: 'pending'
  sync: undefined
}

export interface FulfilledResource<T> extends PromiseLike<T> {
  status: 'fulfilled'
  sync: undefined | true
  value: T
}

export interface RejectedResource<T> extends PromiseLike<T> {
  status: 'rejected'
  sync: undefined | true
  reason: unknown
}

export type TrackedResource<T> =
  | PendingResource<T>
  | FulfilledResource<T>
  | RejectedResource<T>
export type Resource<T> = UntrackedResource<T> | TrackedResource<T>

export function use<T>(resource: Resource<T>): T {
  if (resource.status === 'pending') {
    throw resource
  }
  if (resource.status === 'fulfilled') {
    return resource.value
  }
  if (resource.status === 'rejected') {
    throw resource.reason
  }

  throw setupTracking(resource)
}

export function read<T>(resource: TrackedResource<T>): TrackedResource<T> | T {
  if (resource.sync === undefined) {
    return resource
  }

  if (resource.status === 'rejected') {
    throw resource.reason
  }

  return resource.value
}

export function isEqual<T>(
  a: TrackedResource<T>,
  b: TrackedResource<T>,
  type: { is: (a: T, b: T) => boolean },
): boolean {
  if (a.status !== b.status) {
    return false
  }

  switch (a.status) {
    case 'pending':
      return a === b
    case 'fulfilled':
      return type.is(a.value, (b as FulfilledResource<T>).value)
    case 'rejected':
      return Object.is(a.reason, (b as RejectedResource<T>).reason)
  }
}

export function track<T, U>(resource: Resource<T> & U): TrackedResource<T> & U {
  return resource.status === undefined ? setupTracking(resource) : resource
}

interface AnyResource<T> extends PromiseLike<T> {
  status?: 'pending' | 'fulfilled' | 'rejected' | undefined
  sync?: undefined | true
  value?: T
  reason?: unknown
}

function setupTracking<T, U>(
  resource: AnyResource<T> & U,
): TrackedResource<T> & U {
  resource.status = 'pending'
  resource.then(
    (value) => {
      resource.status = 'fulfilled'
      resource.value = value
    },
    (reason) => {
      resource.status = 'rejected'
      resource.reason = reason
    },
  )

  return resource as TrackedResource<T>
}

export function toResource<Value>(
  v: Value | Resource<Awaited<Value>>,
): TrackedResource<Awaited<Value>> {
  return isResource(v)
    ? replace(undefined, v)
    : toFulfilled(v as Awaited<Value>)
}

export function toFulfilled<T>(value: T): FulfilledResource<T> {
  return new SyncFulfilledResource(value)
}

class SyncFulfilledResource<T> implements FulfilledResource<T> {
  public status = 'fulfilled' as const

  public sync = true as const

  public value: T

  public reason = undefined

  public constructor(value: T) {
    this.value = value
  }

  public then<U, V>(
    onFulfill?: (value: T) => U | PromiseLike<U>,
    onReject?: (error: unknown) => V | PromiseLike<V>,
  ): PromiseLike<U | V> {
    return Promise.resolve(this.value).then(onFulfill, onReject)
  }
}

export function toRejected<T>(reason: unknown): RejectedResource<T> {
  return new SyncRejectedResource(reason)
}

class SyncRejectedResource<T> implements RejectedResource<T> {
  public status = 'rejected' as const

  public sync = true as const

  public value = undefined

  public reason: unknown

  public constructor(reason: unknown) {
    this.reason = reason
  }

  public then<U, V>(
    onFulfill?: (value: T) => U | PromiseLike<U>,
    onReject?: (error: unknown) => V | PromiseLike<V>,
  ): PromiseLike<U | V> {
    return Promise.reject(this.reason).then(onFulfill, onReject)
  }
}

export function isResource<T, U>(value: Resource<T> | U): value is Resource<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

const ORIGINAL = Symbol('ORIGINAL')
const HANDLE = Symbol('HANDLE')

type Handle<T> = { f: ((value: T | PromiseLike<T>) => void) | void }

export type ReplaceableResource<T> = TrackedResource<T> & {
  [ORIGINAL]?: Resource<T>
  [HANDLE]?: Handle<T> | undefined
}

export function original<T>(gate: ReplaceableResource<T>): Resource<T> {
  return gate[ORIGINAL] ?? gate
}

export function replace<T>(
  gate: ReplaceableResource<T> | undefined,
  resource: Resource<T>,
): ReplaceableResource<T> {
  if (gate === undefined) {
    return replaceable(resource)
  }

  if (resource === gate || resource === gate[ORIGINAL]) {
    return gate
  }

  const nextGate = replaceable(resource)
  if (gate[HANDLE]?.f === undefined) {
    return nextGate
  }

  if (nextGate[ORIGINAL] === gate[ORIGINAL]) {
    return gate
  }

  gate[HANDLE].f(nextGate)
  gate[HANDLE].f = undefined
  gate[HANDLE] = nextGate[HANDLE]
  // if `nextGate` was already settled then it wont have an original set
  // use `original` function which handles this case
  gate[ORIGINAL] = original(nextGate)

  return gate
}

function replaceable<T>(
  resource: ReplaceableResource<T> | UntrackedResource<T>,
): ReplaceableResource<T> {
  if (resource.status === 'fulfilled' || resource.status === 'rejected') {
    return resource
  }

  if (resource.status === 'pending' && resource[HANDLE]?.f !== undefined) {
    return resource
  }

  const handle: Handle<T> = { f: undefined }
  const gate: ReplaceableResource<T> = setupTracking(
    new Promise<T>((f, r) => {
      handle.f = f
      resource.then(
        (value) => handle.f === f && (handle.f = f(value)),
        (reason) => handle.f === f && (handle.f = r(reason)),
      )
    }),
  )
  gate[ORIGINAL] = resource
  gate[HANDLE] = handle

  return gate
}
