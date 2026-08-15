/**
 * 弹窗 Escape 栈：多个弹窗叠放时只让「最上层」响应 Escape。
 * 各弹窗打开时把关闭处理 push 进栈、卸载时 pop；全局 dispatcher 只调用栈顶。
 * 修复：此前每个弹窗独立监听 window keydown，一次 Escape 会同时关闭所有层
 * （如命令面板叠在设置上时，输入内容被误丢）。
 */
import { useEffect, useRef } from 'react'

const stack: Array<() => void> = []

/** 注册本弹窗的 Escape 处理，返回注销函数（组件卸载时调用） */
export function pushEscapeHandler(handler: () => void): () => void {
  stack.push(handler)
  return () => {
    const i = stack.indexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  }
}

/**
 * 稳定的 Escape 注册 hook：回调经 ref 读取最新值，只在挂载时注册一次。
 * 若直接依赖 onClose（父组件内联箭头每次渲染新引用），effect 反复
 * pop/re-push 会把本弹窗 handler 抖到栈顶，覆盖其上方弹窗（Escape 关错层）。
 * enabled=false 时不入栈（如常驻组件只在打开时占栈——否则会永久吞掉全局 Escape）。
 */
export function useEscapeHandler(handler: () => void, enabled = true): void {
  const ref = useRef(handler)
  const enabledRef = useRef(enabled)
  useEffect(() => {
    ref.current = handler // 渲染后同步最新回调（渲染期间写 ref 会被 lint 规则拦截）
    enabledRef.current = enabled
  })
  useEffect(() => {
    if (!enabled) return // 禁用时（如弹窗未打开）不入栈
    return pushEscapeHandler(() => {
      if (enabledRef.current) ref.current()
    })
  }, [enabled])
}

/** 应用启动时安装一次（capture 阶段拦截，优先于各弹窗自己的监听） */
export function installEscapeDispatcher(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && stack.length > 0) {
        e.preventDefault()
        e.stopImmediatePropagation()
        stack[stack.length - 1]() // 只关最上层
      }
    },
    true,
  )
}

