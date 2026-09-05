/**
 * M40 controlled renderer result validation.
 *
 * These functions only validate and normalize data. They never load an image,
 * call Canvas APIs, invoke an adapter, or resolve a path on the host machine.
 */
import { normalizePluginRelativePath, type PluginResource, type RendererAdapterDescriptor, type RenderCommandType, type ValidationResult } from './manifest'

export interface DrawTileCommand {
  type: 'drawTile'
  resourceId?: string
  path?: string
  x: number
  y: number
  width: number
  height: number
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
  alpha?: number
}

export interface FillRectCommand {
  type: 'fillRect'
  x: number
  y: number
  width: number
  height: number
  color: string
  alpha?: number
}

export interface ImageRefCommand {
  type: 'imageRef'
  resourceId?: string
  path?: string
  x?: number
  y?: number
  width?: number
  height?: number
  alpha?: number
}

export type RenderCommand = DrawTileCommand | FillRectCommand | ImageRefCommand

export interface RenderResult {
  commands: ReadonlyArray<RenderCommand>
}

export interface RenderValidationLimits {
  maxCommands: number
  maxResponseBytes: number
  maxCoordinate: number
  maxDimension: number
  maxArea: number
  /** Total destination pixel budget across all commands. */
  maxPixels: number
}

export interface RendererSceneLimits {
  maxBytes: number
  maxItems: number
}

export interface RendererExecutionOptions {
  adapter?: Pick<RendererAdapterDescriptor, 'allowedCommands' | 'resourceIds' | 'maxCommands' | 'maxResponseBytes'>
  resources?: ReadonlyArray<PluginResource>
  limits?: Partial<RenderValidationLimits>
  sceneLimits?: Partial<RendererSceneLimits>
  timeoutMs?: number
}

export interface RendererExecutionResult {
  result: RenderResult
  usedFallback: boolean
  reason?: 'scene' | 'timeout' | 'exception' | 'invalid-result'
}

export interface RenderValidationOptions {
  adapter?: Pick<RendererAdapterDescriptor, 'allowedCommands' | 'resourceIds' | 'maxCommands' | 'maxResponseBytes'>
  resources?: ReadonlyArray<PluginResource>
  limits?: Partial<RenderValidationLimits>
}

export const RENDER_LIMITS: Readonly<RenderValidationLimits> = Object.freeze({
  maxCommands: 256,
  maxResponseBytes: 256 * 1024,
  maxCoordinate: 4096,
  maxDimension: 4096,
  maxArea: 16 * 1024 * 1024,
  maxPixels: 24 * 1024 * 1024,
})

export const RENDERER_SCENE_LIMITS: Readonly<RendererSceneLimits> = Object.freeze({
  maxBytes: 256 * 1024,
  maxItems: 4096,
})

const COMMAND_TYPES: ReadonlySet<RenderCommandType> = new Set(['drawTile', 'fillRect', 'imageRef'])
const COMMAND_KEYS: Readonly<Record<RenderCommandType, ReadonlySet<string>>> = {
  drawTile: new Set(['type', 'resourceId', 'path', 'x', 'y', 'width', 'height', 'sourceX', 'sourceY', 'sourceWidth', 'sourceHeight', 'alpha']),
  fillRect: new Set(['type', 'x', 'y', 'width', 'height', 'color', 'alpha']),
  imageRef: new Set(['type', 'resourceId', 'path', 'x', 'y', 'width', 'height', 'alpha']),
}
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}(?:[0-9a-f]{2})?)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isSafeResponseData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && isSafeResponseData(descriptor.value, seen))
  })
  if (!isRecord(value)) return false
  return Object.keys(value).every((key) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key === 'toJSON') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && isSafeResponseData(descriptor.value, seen))
  })
}

function utf8Size(value: unknown): number | null {
  if (!isSafeResponseData(value)) return null
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : new TextEncoder().encode(text).byteLength
  } catch {
    return null
  }
}

function finiteNumber(value: unknown, field: string, errors: string[], integer = false): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    errors.push(`${field} 必须是有限${integer ? '整数' : '数字'}`)
    return false
  }
  return true
}

function bounded(value: unknown, field: string, min: number, max: number, errors: string[], integer = false): value is number {
  if (!finiteNumber(value, field, errors, integer)) return false
  if (value < min || value > max) errors.push(`${field} 必须在 ${min}-${max} 范围内`)
  return true
}

function validateGeometry(command: Record<string, unknown>, prefix: string, limits: RenderValidationLimits, errors: string[], optional = false): void {
  for (const field of ['x', 'y']) {
    if (command[field] === undefined && optional) continue
    bounded(command[field], `${prefix}.${field}`, -limits.maxCoordinate, limits.maxCoordinate, errors)
  }
  for (const field of ['width', 'height']) {
    if (command[field] === undefined && optional) continue
    bounded(command[field], `${prefix}.${field}`, 1, limits.maxDimension, errors)
  }
  const width = command.width
  const height = command.height
  if (typeof width === 'number' && Number.isFinite(width) && typeof height === 'number' && Number.isFinite(height) && width * height > limits.maxArea) {
    errors.push(`${prefix}.width*height 超出面积限制`)
  }
}

function validateAlpha(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return
  bounded(value, field, 0, 1, errors)
}

function validateSourceRect(command: Record<string, unknown>, prefix: string, limits: RenderValidationLimits, errors: string[]): void {
  const fields = ['sourceX', 'sourceY', 'sourceWidth', 'sourceHeight']
  const present = fields.filter((field) => command[field] !== undefined)
  if (present.length !== 0 && present.length !== fields.length) {
    errors.push(`${prefix} 的 sourceX/sourceY/sourceWidth/sourceHeight 必须同时提供`)
    return
  }
  for (const field of fields.slice(0, 2)) if (command[field] !== undefined) bounded(command[field], `${prefix}.${field}`, 0, limits.maxCoordinate, errors)
  for (const field of fields.slice(2)) if (command[field] !== undefined) bounded(command[field], `${prefix}.${field}`, 1, limits.maxDimension, errors)
  const width = command.sourceWidth
  const height = command.sourceHeight
  if (typeof width === 'number' && typeof height === 'number' && width * height > limits.maxArea) errors.push(`${prefix} 源矩形面积超出限制`)
}

function validateResource(command: Record<string, unknown>, prefix: string, options: RenderValidationOptions, errors: string[]): void {
  const resourceId = command.resourceId
  const path = command.path
  if ((resourceId === undefined) === (path === undefined)) {
    errors.push(`${prefix} 必须且只能提供 resourceId 或 path`)
    return
  }
  const declaredResources = options.resources ?? []
  const allowedIds = new Set(options.adapter?.resourceIds ?? declaredResources.map((resource) => resource.id))
  const resourcesById = new Map(declaredResources.map((resource) => [resource.id, resource]))
  const resourcesByPath = new Map(declaredResources.map((resource) => [resource.path.toLowerCase(), resource]))
  if (resourceId !== undefined) {
    if (typeof resourceId !== 'string') {
      errors.push(`${prefix}.resourceId 必须是字符串`)
      return
    }
    const resource = resourcesById.get(resourceId)
    if (!resource || !allowedIds.has(resourceId) || resource.kind !== 'image') errors.push(`${prefix}.resourceId 不是允许的图像资源 ID`)
    return
  }
  if (typeof path !== 'string') {
    errors.push(`${prefix}.path 必须是相对路径`)
    return
  }
  const normalized = normalizePluginRelativePath(path)
  if (!normalized) {
    errors.push(`${prefix}.path 不能是绝对路径、网络地址或路径穿越`)
    return
  }
  const resource = resourcesByPath.get(normalized.toLowerCase())
  if (!resource) {
    errors.push(`${prefix}.path 不是输入资源路径`)
    return
  }
  const ext = resource.path.slice(resource.path.lastIndexOf('.')).toLowerCase()
  if (resource.kind !== 'image' || !new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico']).has(ext)) {
    errors.push(`${prefix}.path 不是可绘制图像资源`)
  }
}

function validateKeys(command: Record<string, unknown>, type: RenderCommandType, prefix: string, errors: string[]): void {
  const allowed = COMMAND_KEYS[type]
  for (const key of Object.keys(command)) if (!allowed.has(key)) errors.push(`${prefix} 含未知字段「${key}」`)
}

function normalizeCommand(command: Record<string, unknown>): RenderCommand {
  const type = command.type
  if (type === 'fillRect') return {
    type,
    x: command.x as number,
    y: command.y as number,
    width: command.width as number,
    height: command.height as number,
    color: command.color as string,
    ...(command.alpha === undefined ? {} : { alpha: command.alpha as number }),
  }
  if (type === 'drawTile') return {
    type,
    ...(command.resourceId === undefined ? {} : { resourceId: command.resourceId as string }),
    ...(command.path === undefined ? {} : { path: command.path as string }),
    x: command.x as number,
    y: command.y as number,
    width: command.width as number,
    height: command.height as number,
    ...(command.sourceX === undefined ? {} : { sourceX: command.sourceX as number }),
    ...(command.sourceY === undefined ? {} : { sourceY: command.sourceY as number }),
    ...(command.sourceWidth === undefined ? {} : { sourceWidth: command.sourceWidth as number }),
    ...(command.sourceHeight === undefined ? {} : { sourceHeight: command.sourceHeight as number }),
    ...(command.alpha === undefined ? {} : { alpha: command.alpha as number }),
  }
  return {
    type: 'imageRef',
    ...(command.resourceId === undefined ? {} : { resourceId: command.resourceId as string }),
    ...(command.path === undefined ? {} : { path: command.path as string }),
    ...(command.x === undefined ? {} : { x: command.x as number }),
    ...(command.y === undefined ? {} : { y: command.y as number }),
    ...(command.width === undefined ? {} : { width: command.width as number }),
    ...(command.height === undefined ? {} : { height: command.height as number }),
    ...(command.alpha === undefined ? {} : { alpha: command.alpha as number }),
  }
}

/**
 * Validate an adapter response. Input may be the command array itself or the
 * transport-friendly `{ commands: [...] }` envelope.
 */
export function validateRenderResult(input: unknown, options: RenderValidationOptions = {}): ValidationResult<RenderResult> {
  const errors: string[] = []
  const rawCommands = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.commands) ? input.commands : null
  if (!rawCommands) return { ok: false, errors: ['渲染结果必须是指令数组或 { commands } 对象'] }
  if (isRecord(input)) for (const key of Object.keys(input)) if (key !== 'commands') errors.push(`渲染结果含未知字段「${key}」`)
  const requested = options.limits ?? {}
  const limits: RenderValidationLimits = {
    maxCommands: Number.isInteger(requested.maxCommands) ? Math.min(RENDER_LIMITS.maxCommands, requested.maxCommands as number) : RENDER_LIMITS.maxCommands,
    maxResponseBytes: Number.isInteger(requested.maxResponseBytes) ? Math.min(RENDER_LIMITS.maxResponseBytes, requested.maxResponseBytes as number) : RENDER_LIMITS.maxResponseBytes,
    maxCoordinate: typeof requested.maxCoordinate === 'number' && Number.isFinite(requested.maxCoordinate) ? Math.min(RENDER_LIMITS.maxCoordinate, requested.maxCoordinate) : RENDER_LIMITS.maxCoordinate,
    maxDimension: typeof requested.maxDimension === 'number' && Number.isFinite(requested.maxDimension) ? Math.min(RENDER_LIMITS.maxDimension, requested.maxDimension) : RENDER_LIMITS.maxDimension,
    maxArea: typeof requested.maxArea === 'number' && Number.isFinite(requested.maxArea) ? Math.min(RENDER_LIMITS.maxArea, requested.maxArea) : RENDER_LIMITS.maxArea,
    maxPixels: typeof requested.maxPixels === 'number' && Number.isFinite(requested.maxPixels) ? Math.min(RENDER_LIMITS.maxPixels, requested.maxPixels) : RENDER_LIMITS.maxPixels,
  }
  const adapterMax = options.adapter?.maxCommands
  const maxCommands = adapterMax === undefined ? limits.maxCommands : Math.min(limits.maxCommands, adapterMax)
  if (!Number.isInteger(maxCommands) || maxCommands < 1) return { ok: false, errors: ['渲染指令数量上限无效'] }
  if (rawCommands.length > maxCommands) errors.push(`渲染指令数量超过 ${maxCommands}`)
  const responseBytes = utf8Size(input)
  const maxResponseBytes = Math.min(limits.maxResponseBytes, options.adapter?.maxResponseBytes ?? limits.maxResponseBytes)
  if (responseBytes === null || responseBytes > maxResponseBytes) errors.push(`渲染响应超过 ${maxResponseBytes} 字节`)

  const allowedCommands = new Set(options.adapter?.allowedCommands ?? COMMAND_TYPES)
  let totalPixels = 0
  const normalized: RenderCommand[] = []
  rawCommands.forEach((rawCommand, index) => {
    const prefix = `commands[${index}]`
    if (!isRecord(rawCommand)) {
      errors.push(`${prefix} 必须是对象`)
      return
    }
    const type = rawCommand.type
    if (typeof type !== 'string' || !COMMAND_TYPES.has(type as RenderCommandType)) {
      errors.push(`${prefix}.type 不是受支持的绘制指令`)
      return
    }
    if (!allowedCommands.has(type as RenderCommandType)) errors.push(`${prefix}.type 未被 adapter 声明允许`)
    validateKeys(rawCommand, type as RenderCommandType, prefix, errors)
    if (type === 'fillRect') {
      validateGeometry(rawCommand, prefix, limits, errors)
      if (typeof rawCommand.color !== 'string' || !COLOR_RE.test(rawCommand.color)) errors.push(`${prefix}.color 必须是十六进制颜色`)
      validateAlpha(rawCommand.alpha, `${prefix}.alpha`, errors)
    } else if (type === 'drawTile') {
      validateResource(rawCommand, prefix, options, errors)
      validateGeometry(rawCommand, prefix, limits, errors)
      validateSourceRect(rawCommand, prefix, limits, errors)
      validateAlpha(rawCommand.alpha, `${prefix}.alpha`, errors)
    } else {
      validateResource(rawCommand, prefix, options, errors)
      validateGeometry(rawCommand, prefix, limits, errors, true)
      validateAlpha(rawCommand.alpha, `${prefix}.alpha`, errors)
    }
    if (errors.length === 0) {
      const width = typeof rawCommand.width === 'number' ? rawCommand.width : 1
      const height = typeof rawCommand.height === 'number' ? rawCommand.height : 1
      totalPixels += width * height
      if (totalPixels > limits.maxPixels) errors.push(`渲染总像素预算超过 ${limits.maxPixels}`)
      else normalized.push(normalizeCommand(rawCommand))
    }
  })
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] }
  return { ok: true, value: { commands: normalized } }
}

export const validateRendererOutput = validateRenderResult
export const validateRendererResult = validateRenderResult
export const validateRenderCommands = validateRenderResult
export const validateDrawingCommands = validateRenderResult

function sceneSize(scene: unknown): number | null {
  if (!isSafeResponseData(scene)) return null
  try {
    const encoded = JSON.stringify(scene)
    return encoded === undefined ? null : new TextEncoder().encode(encoded).byteLength
  } catch {
    return null
  }
}

function sceneItemCount(scene: unknown): number {
  if (Array.isArray(scene)) return scene.length
  if (isRecord(scene)) {
    const items = scene.items
    if (Array.isArray(items)) return items.length
    return Object.keys(scene).length
  }
  return 0
}

function cloneScene(scene: unknown): unknown {
  const encoded = JSON.stringify(scene)
  if (encoded === undefined) throw new Error('场景数据不可序列化')
  return JSON.parse(encoded) as unknown
}

function freezeScene<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) freezeScene(item)
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeScene(item)
  }
  return Object.freeze(value)
}

/**
 * Execute one host-registered adapter with a copied, frozen scene.
 * Adapters are supplied by trusted host code; manifests never contain executable code.
 * Any scene, timeout, exception, or result violation returns the built-in fallback.
 */
export async function executeRendererAdapter(
  adapter: (scene: unknown) => unknown | Promise<unknown>,
  scene: unknown,
  fallback: RenderResult,
  options: RendererExecutionOptions = {},
): Promise<RendererExecutionResult> {
  const sceneLimits = { ...RENDERER_SCENE_LIMITS, ...(options.sceneLimits ?? {}) }
  const bytes = sceneSize(scene)
  if (bytes === null || bytes > sceneLimits.maxBytes || sceneItemCount(scene) > sceneLimits.maxItems) {
    return { result: fallback, usedFallback: true, reason: 'scene' }
  }
  const timeoutMs = Math.max(1, Math.min(500, Math.floor(options.timeoutMs ?? 100)))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const safeScene = freezeScene(cloneScene(scene))
    const pending = Promise.resolve().then(() => adapter(safeScene))
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('renderer adapter timeout')), timeoutMs)
    })
    const raw = await Promise.race([pending, timeout])
    const checked = validateRenderResult(raw, options)
    if (!checked.ok) return { result: fallback, usedFallback: true, reason: 'invalid-result' }
    return { result: checked.value, usedFallback: false }
  } catch (error) {
    void error
    return { result: fallback, usedFallback: true, reason: error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'exception' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
