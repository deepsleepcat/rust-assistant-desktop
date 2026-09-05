/**
 * 宿主 adapter 注册表（M40 renderer adapter 消费入口）：
 * 插件 manifest 只含声明式 rendererAdapter 描述，不含可执行代码；
 * 受信任的宿主代码（内置功能）通过 registerRendererAdapter 注册实现，
 * 消费方（渲染路径）经 runRendererAdapter 执行——内部统一走
 * executeRendererAdapter 的场景冻结/超时/预算/回退链。
 * 没有注册任何 adapter 时直接返回内置回退，绝不动态加载插件代码。
 */
import type { RenderResult } from './renderer'
import { executeRendererAdapter, type RendererExecutionOptions, type RendererExecutionResult } from './renderer'

export interface RegisteredRendererAdapter {
  /** 对应插件 manifest 的 id（小写规范化） */
  pluginId: string
  /** 受信任的宿主实现：输入为冻结的场景副本，输出为绘制指令 envelope */
  run: (scene: unknown) => unknown | Promise<unknown>
}

const registry = new Map<string, RegisteredRendererAdapter>()

/** 注册（或替换）一个插件 id 的宿主 adapter 实现。仅限宿主代码调用。 */
export function registerRendererAdapter(adapter: RegisteredRendererAdapter): void {
  registry.set(adapter.pluginId.toLowerCase(), adapter)
}

/** 注销一个宿主 adapter（插件卸载/禁用时调用）。 */
export function unregisterRendererAdapter(pluginId: string): void {
  registry.delete(pluginId.toLowerCase())
}

/** 当前已注册的插件 id 列表（诊断用）。 */
export function registeredAdapterIds(): string[] {
  return [...registry.keys()]
}

export interface RendererAdapterRunResult extends RendererExecutionResult {
  /** 实际执行的插件 id；没有任何注册实现时为 null */
  executedPluginId: string | null
}

/**
 * 按插件 id 执行已注册的宿主 adapter：
 * - 未注册 → 直接返回内置回退（executedPluginId=null，不算异常）；
 * - 已注册 → 经 executeRendererAdapter 执行（冻结场景/超时/预算/非法结果统一回退）。
 * fallback 必须由消费方提供（通常是内置渲染器的保守绘制结果）。
 */
export async function runRendererAdapter(
  pluginId: string,
  scene: unknown,
  fallback: RenderResult,
  options: RendererExecutionOptions = {},
): Promise<RendererAdapterRunResult> {
  const registered = registry.get(pluginId.toLowerCase())
  if (!registered) {
    return { result: fallback, usedFallback: true, reason: 'scene', executedPluginId: null }
  }
  const execution = await executeRendererAdapter(registered.run, scene, fallback, options)
  return { ...execution, executedPluginId: registered.pluginId }
}

/** 测试隔离：清空注册表（生产代码不要调用）。 */
export function resetRendererAdaptersForTest(): void {
  registry.clear()
}
