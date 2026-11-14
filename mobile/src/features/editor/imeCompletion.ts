/** Guards the post-IME completion refresh so ordinary composition commits stay quiet. */
export interface CompositionReopenState {
  startedDoc: string | null
  endedDoc: string
  hasFocus: boolean
  now: number
  suppressReopenUntil: number
}

export function shouldReopenAfterComposition(state: CompositionReopenState): boolean {
  return (
    state.startedDoc !== null &&
    state.startedDoc !== state.endedDoc &&
    state.hasFocus &&
    state.now >= state.suppressReopenUntil
  )
}
