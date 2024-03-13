interface RawResource<T> {
  then<U, V>(
    onFulfill?: (value: T) => U | PromiseLike<U>,
    onReject?: (error: unknown) => V | PromiseLike<V>,
  ): PromiseLike<U | V>
}

export interface UntrackedResource<T> extends RawResource<T> {
  status?: undefined
}

export interface PendingResource<T> extends RawResource<T> {
  status: 'pending'
}

export interface FulfilledResource<T> extends RawResource<T> {
  status: 'fulfilled'
  value: T
}

export interface RejectedResource<T> extends RawResource<T> {
  status: 'rejected'
  reason: unknown
}

export type TrackedResource<T> =
  | PendingResource<T>
  | FulfilledResource<T>
  | RejectedResource<T>
export type Resource<T> = TrackedResource<T> | UntrackedResource<T>

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

export function track<T, U>(resource: Resource<T> & U): TrackedResource<T> & U {
  return resource.status === undefined ? setupTracking(resource) : resource
}

interface AnyResource<T> extends RawResource<T> {
  status?: 'pending' | 'fulfilled' | 'rejected' | undefined
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

export function fulfilled<T>(value: T): FulfilledResource<T> {
  return new ConcreteFulfilledResource(value)
}

class ConcreteFulfilledResource<T> implements FulfilledResource<T> {
  public status = 'fulfilled' as const

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

export function rejected<T>(reason: unknown): RejectedResource<T> {
  return new ConcreteRejectedResource(reason)
}

class ConcreteRejectedResource<T> implements RejectedResource<T> {
  public status = 'rejected' as const

  public value = undefined

  public reason: unknown

  public constructor(reason: unknown) {
    this.reason = reason
  }

  public then<U, V>(
    onFulfill?: (value: T) => U | PromiseLike<U>,
    onReject?: (error: unknown) => V | PromiseLike<V>,
  ): PromiseLike<U | V> {
    return Promise.reject(this.value).then(onFulfill, onReject)
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
const RESOLVE = Symbol('RESOLVE')

type Resolve<T> = (value: T | PromiseLike<T>) => void

export type ReplaceableResource<T> = TrackedResource<T> & {
  [ORIGINAL]?: Resource<T> | void
  [RESOLVE]?: Resolve<T> | void
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

  if (gate[RESOLVE] === undefined) {
    return replaceable(resource)
  }

  const nextGate = replaceable(resource)
  if (nextGate[ORIGINAL] === gate[ORIGINAL]) {
    return gate
  }

  gate[RESOLVE](nextGate)
  gate[ORIGINAL] = nextGate[ORIGINAL]
  gate[RESOLVE] = nextGate[RESOLVE]

  return gate
}

function replaceable<T>(
  resource: ReplaceableResource<T> | UntrackedResource<T>,
): ReplaceableResource<T> {
  if (resource.status === 'fulfilled' || resource.status === 'rejected') {
    return resource
  }

  if (resource.status === 'pending' && resource[RESOLVE] !== undefined) {
    return resource
  }

  let resolve: Resolve<T>
  const gate = setupTracking(
    new Promise<T>((f, r) => {
      resolve = f
      resource.then(
        (value) => gate[RESOLVE] === f && (gate[RESOLVE] = f(value)),
        (reason) => gate[RESOLVE] === f && (gate[RESOLVE] = r(reason)),
      )
    }),
  ) as ReplaceableResource<T>
  gate[ORIGINAL] = resource
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- has definitely been assigned above
  gate[RESOLVE] = resolve!

  return gate
}
