/// <reference types="react/experimental" />

import ReactExports, {
  useDebugValue,
  useEffect,
  useReducer,
  useRef,
} from 'react'
import {
  ReplaceableResource,
  Resource,
  use as jotaiUse,
  original,
  replace,
} from '../vanilla/internal.ts'
import type { Atom, ExtractAtomValue, Store } from '../vanilla.ts'
import { useStore } from './Provider.ts'

const use = ReactExports.use ?? jotaiUse

type Action<Value> = {
  store: Store
  atom: Atom<Value>
  value: Resource<Awaited<Value>>
}
type State<Value> = {
  store: Store
  atom: Atom<Value>
  value: ReplaceableResource<Awaited<Value>>
}
type Reducer<Value> = (
  prev: State<Value>,
  action: Action<Value>,
) => State<Value>
type Initializer<Value> = (arg: undefined) => State<Value>

type Instance<Value> = {
  delay: number | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  reducer: Reducer<Value>
  initializer: Initializer<Value>
}

type Options = Parameters<typeof useStore>[0] & {
  delay?: number
}

export function useAtomValue<Value>(
  atom: Atom<Value>,
  options?: Options,
): Awaited<Value>

export function useAtomValue<AtomType extends Atom<any>>(
  atom: AtomType,
  options?: Options,
): Awaited<ExtractAtomValue<AtomType>>

export function useAtomValue<Value>(
  atom: Atom<Value>,
  options?: Options,
): Awaited<Value> {
  const store = useStore(options)
  const ref = useRef(undefined as unknown as Instance<Value>)

  let instance = ref.current
  if (instance === undefined) {
    instance = {
      delay: undefined,
      timeout: undefined,
      reducer: (prev, { store, atom, value }) => {
        const nextValue = replace(prev.value, value)

        return prev.value === nextValue &&
          prev.atom === atom &&
          prev.store === store
          ? prev
          : { store, atom, value: nextValue }
      },
      initializer: () => {
        // instance.initializer = undefined

        return { store, atom, value: replace(undefined, store.resource(atom)) }
      },
    }

    ref.current = instance
  }

  instance.delay = options?.delay
  clearTimeout(instance.timeout)

  const [state, update] = useReducer(
    instance.reducer,
    undefined,
    instance.initializer,
  )

  let { value } = state
  if (state.store !== store || state.atom !== atom) {
    value = replace(value, store.resource(atom))
    update({ store, atom, value })
  }

  useEffect(() => {
    const instance = ref.current

    const unsub = store.sub(atom, () => {
      if (instance.delay === undefined) {
        return update({ store, atom, value: store.resource(atom) })
      }

      // delay rerendering to wait a promise possibly to resolve
      clearTimeout(instance.timeout)
      instance.timeout = setTimeout(
        () => update({ store, atom, value: store.resource(atom) }),
        instance.delay,
      )
    })

    // in case a new resource was set before the effect was called and therefore
    // before we subscribed `update` to the store we just run `update` now.
    // it is a noop if `instance.resource` has not changed
    update({ store, atom, value: store.resource(atom) })

    return () => {
      unsub()
      clearTimeout(instance.timeout)
    }
  }, [store, atom])

  useDebugValue(original(value))

  return use(value)
}
