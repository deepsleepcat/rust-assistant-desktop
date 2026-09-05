import { describe, expect, it } from 'vitest'
import {
  createPluginState,
  disablePlugin,
  enablePlugin,
  findPluginConflicts,
  installPlugin,
  removePlugin,
  togglePlugin,
  validatePluginConflicts,
  validatePluginImport,
  validatePluginManifest,
  executeRendererAdapter,
  validateRenderResult,
  type PluginManifest,
} from '../src/features/plugins'
import { loadEnabledPluginData } from '../src/features/plugins/runtimeData'
import {
  registerRendererAdapter,
  registeredAdapterIds,
  resetRendererAdaptersForTest,
  runRendererAdapter,
  unregisterRendererAdapter,
} from '../src/features/plugins/adapterRegistry'
import { afterEach } from 'vitest'

const VALID_MANIFEST_INPUT = {
  manifestVersion: 1,
  id: 'terrain.tools',
  version: '1.2.3',
  name: 'Terrain tools',
  capabilities: ['translations', 'fieldAliases', 'enumExplanations', 'rules', 'rendererAdapter'],
  translations: { en: { terrainName: 'Terrain' } },
  fieldAliases: { maxHp: ['health'] },
  enumExplanations: { moveType: { land: 'Land unit' } },
  rules: {
    formatVersion: 1,
    name: 'Terrain rules',
    rules: [{ id: 'max-hp', title: 'Maximum health', check: { type: 'numeric-range', min: 1, max: 10000 } }],
  },
  resources: [{ id: 'atlas', path: 'assets/atlas.png', kind: 'image' }],
  rendererAdapter: {
    formatVersion: 1,
    kind: 'canvas-2d',
    allowedCommands: ['drawTile', 'fillRect', 'imageRef'],
    resourceIds: ['atlas'],
    maxCommands: 8,
    maxResponseBytes: 4096,
  },
}

function validManifest(): PluginManifest {
  const result = validatePluginManifest(VALID_MANIFEST_INPUT)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.value
}

function errorsOf(result: { ok: boolean; errors?: string[] }): string[] {
  return result.ok ? [] : result.errors ?? []
}

describe('M40 plugin manifest and import validation', () => {
  it('accepts the declarative manifest shape and normalizes it', () => {
    const result = validatePluginManifest(VALID_MANIFEST_INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toBe('terrain.tools')
      expect(result.value.rules?.rules[0]?.id).toBe('max-hp')
      expect(result.value.resources[0]?.path).toBe('assets/atlas.png')
      expect(result.value.rendererAdapter?.allowedCommands).toEqual(['drawTile', 'fillRect', 'imageRef'])
    }
  })

  it('rejects malicious manifest fields, invalid IDs, versions, and capability drift', () => {
    expect(errorsOf(validatePluginManifest({ ...VALID_MANIFEST_INPUT, script: 'node payload.js' }))).toEqual(expect.arrayContaining([expect.stringContaining('脚本')]))
    expect(validatePluginManifest({ ...VALID_MANIFEST_INPUT, id: '../escape' }).ok).toBe(false)
    expect(validatePluginManifest({ ...VALID_MANIFEST_INPUT, version: 'latest' }).ok).toBe(false)
    expect(validatePluginManifest({ ...VALID_MANIFEST_INPUT, capabilities: ['translations'] }).ok).toBe(false)
    expect(validatePluginManifest({ ...VALID_MANIFEST_INPUT, rules: [{ id: 'unsafe', title: 'unsafe', check: { type: 'run-script' } }] }).ok).toBe(false)
  })

  it('rejects absolute and traversal resource paths', () => {
    for (const path of ['../secret.png', '..\\secret.png', 'C:/secret.png', '/secret.png', 'https://host/asset.png', 'data:text/plain,x']) {
      const result = validatePluginManifest({ ...VALID_MANIFEST_INPUT, resources: [{ id: 'asset', path, kind: 'image' }], rendererAdapter: { ...VALID_MANIFEST_INPUT.rendererAdapter, resourceIds: ['asset'] } })
      expect(result.ok, path).toBe(false)
    }
    const normalized = validatePluginManifest({ ...VALID_MANIFEST_INPUT, resources: [{ id: 'asset', path: 'assets\\tiles\\..\\atlas.png', kind: 'image' }], rendererAdapter: { ...VALID_MANIFEST_INPUT.rendererAdapter, resourceIds: ['asset'] } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.value.resources[0]?.path).toBe('assets/atlas.png')
  })

  it('requires an explicit local JSON or directory import and rejects scripts/EXEs', () => {
    const jsonImport = validatePluginImport({ source: 'json', userInitiated: true, manifest: VALID_MANIFEST_INPUT })
    expect(jsonImport.ok).toBe(true)
    expect(validatePluginImport({ source: 'network', userInitiated: true, manifest: VALID_MANIFEST_INPUT }).ok).toBe(false)
    expect(validatePluginImport({ source: 'json', userInitiated: false, manifest: VALID_MANIFEST_INPUT }).ok).toBe(false)
    expect(validatePluginImport({ source: 'json', userInitiated: true, path: 'C:/outside.json', manifest: VALID_MANIFEST_INPUT }).ok).toBe(false)

    for (const path of ['adapter.js', 'run.exe', 'scripts/payload.ps1', 'node_modules/pkg/index.js']) {
      const result = validatePluginImport({
        source: 'directory',
        userInitiated: true,
        manifest: VALID_MANIFEST_INPUT,
        files: [{ path, size: 10 }],
      })
      expect(result.ok, path).toBe(false)
    }
  })

  it('enforces per-file, package, and manifest size limits', () => {
    expect(validatePluginManifest({ ...VALID_MANIFEST_INPUT, description: 'x'.repeat(300_000) }).ok).toBe(false)
    expect(validatePluginImport({
      source: 'directory',
      userInitiated: true,
      manifest: VALID_MANIFEST_INPUT,
      files: [{ path: 'assets/atlas.png', size: 8 * 1024 * 1024 + 1 }],
    }).ok).toBe(false)
    expect(validatePluginImport({
      source: 'directory',
      userInitiated: true,
      manifest: VALID_MANIFEST_INPUT,
      files: [
        { path: 'assets/a.png', size: 8 * 1024 * 1024 },
        { path: 'assets/b.png', size: 8 * 1024 * 1024 },
        { path: 'assets/c.png', size: 1 },
      ],
    }).ok).toBe(false)
  })
})

describe('M40 controlled renderer result validation', () => {
  const resources = validManifest().resources
  const adapter = validManifest().rendererAdapter

  it('accepts only bounded declarative draw commands', () => {
    const result = validateRenderResult({
      commands: [
        { type: 'fillRect', x: 0, y: 0, width: 64, height: 32, color: '#12abef', alpha: 0.75 },
        { type: 'drawTile', resourceId: 'atlas', x: 8, y: 8, width: 32, height: 32, sourceX: 0, sourceY: 0, sourceWidth: 32, sourceHeight: 32 },
        { type: 'imageRef', resourceId: 'atlas', x: 0, y: 0, width: 64, height: 64 },
      ],
    }, { resources, adapter })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.commands).toHaveLength(3)
  })

  it('rejects unknown commands, command fields, bad colors, and bad alpha', () => {
    expect(validateRenderResult([{ type: 'execute', command: 'rm -rf /' }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: 'red', alpha: 1 }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: '#fff', extra: true }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: '#fff', alpha: 2 }], { resources, adapter }).ok).toBe(false)
  })

  it('host execution freezes a copied scene and returns validated commands', async () => {
    const manifest = validManifest()
    const fallback = { commands: [{ type: 'fillRect' as const, x: 0, y: 0, width: 1, height: 1, color: '#000' }] }
    const scene = { items: [{ id: 'unit-1', x: 1 }] }
    let observed: unknown
    const executed = await executeRendererAdapter((input) => {
      observed = input
      expect(Object.isFrozen(input)).toBe(true)
      expect(Object.isFrozen((input as { items: unknown[] }).items)).toBe(true)
      return { commands: [{ type: 'fillRect', x: 0, y: 0, width: 4, height: 4, color: '#fff' }] }
    }, scene, fallback, { adapter: manifest.rendererAdapter, resources: manifest.resources })
    expect(executed.usedFallback).toBe(false)
    expect(executed.result.commands).toHaveLength(1)
    expect(scene.items[0]).toEqual({ id: 'unit-1', x: 1 })
    expect(observed).not.toBe(scene)
  })

  it('falls back for scene limits, invalid output, exceptions, and timeouts', async () => {
    const manifest = validManifest()
    const fallback = { commands: [{ type: 'fillRect' as const, x: 0, y: 0, width: 1, height: 1, color: '#000' }] }
    const common = { adapter: manifest.rendererAdapter, resources: manifest.resources }
    await expect(executeRendererAdapter(() => [], { items: Array.from({ length: 3 }, (_, id) => ({ id })) }, fallback, { ...common, sceneLimits: { maxItems: 2 } })).resolves.toMatchObject({ usedFallback: true, reason: 'scene', result: fallback })
    await expect(executeRendererAdapter(() => ({ commands: [{ type: 'execute' }] }), {}, fallback, common)).resolves.toMatchObject({ usedFallback: true, reason: 'invalid-result' })
    await expect(executeRendererAdapter(() => { throw new Error('adapter failed') }, {}, fallback, common)).resolves.toMatchObject({ usedFallback: true, reason: 'exception' })
    await expect(executeRendererAdapter(() => new Promise(() => undefined), {}, fallback, { ...common, timeoutMs: 5 })).resolves.toMatchObject({ usedFallback: true, reason: 'timeout' })
    await expect(executeRendererAdapter(() => ({ commands: [{ type: 'fillRect', x: 0, y: 0, width: 4, height: 4, color: '#fff' }, { type: 'fillRect', x: 0, y: 0, width: 4, height: 4, color: '#fff' }] }), {}, fallback, { ...common, limits: { maxPixels: 8 } })).resolves.toMatchObject({ usedFallback: true, reason: 'invalid-result' })
  })

  it('rejects unknown/traversal resources and geometry outside bounds', () => {
    expect(validateRenderResult([{ type: 'imageRef', resourceId: 'other', x: 0, y: 0 }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'imageRef', path: '../atlas.png', x: 0, y: 0 }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'imageRef', path: 'assets/missing.png', x: 0, y: 0 }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 0, y: 0, width: 0, height: 1, color: '#fff' }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 5000, y: 0, width: 1, height: 1, color: '#fff' }], { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'drawTile', resourceId: 'atlas', x: 0, y: 0, width: 1, height: 1, sourceX: 0 }], { resources, adapter }).ok).toBe(false)
  })

  it('enforces command count and serialized response size limits', () => {
    const many = Array.from({ length: 9 }, () => ({ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: '#fff' }))
    expect(validateRenderResult(many, { resources, adapter }).ok).toBe(false)
    expect(validateRenderResult([{ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: `#fff${'x'.repeat(200)}` }], { resources, adapter: { ...adapter!, maxResponseBytes: 32 } }).ok).toBe(false)
  })
})

describe('M40 pure plugin lifecycle and conflict state', () => {
  it('installs, enables, disables, toggles, and removes without mutating state', () => {
    const manifest = validManifest()
    const empty = createPluginState()
    const installed = installPlugin(empty, manifest)
    expect(empty.plugins).toHaveLength(0)
    expect(installed.plugins).toHaveLength(1)
    expect(installed.plugins[0]?.enabled).toBe(true)

    const disabled = disablePlugin(installed, manifest.id)
    expect(disabled.plugins[0]?.enabled).toBe(false)
    expect(installed.plugins[0]?.enabled).toBe(true)
    expect(enablePlugin(disabled, manifest.id).plugins[0]?.enabled).toBe(true)
    expect(togglePlugin(disabled, manifest.id).plugins[0]?.enabled).toBe(true)
    expect(removePlugin(installed, manifest.id).plugins).toEqual([])
    expect(removePlugin(installed, 'missing').plugins).toHaveLength(1)
  })

  it('keeps installed manifests isolated from caller mutation and duplicate installs', () => {
    const manifest = validManifest()
    const state = installPlugin(createPluginState(), manifest)
    manifest.resources[0]!.path = 'changed.png'
    expect(getStatePluginPath(state)).toBe('assets/atlas.png')
    const duplicate = installPlugin(state, { ...manifest, name: 'replacement' })
    expect(duplicate.plugins).toHaveLength(1)
    expect(duplicate.plugins[0]?.manifest.name).toBe('Terrain tools')
  })

  it('reports plugin namespace conflicts before enabling', () => {
    const existing = validManifest()
    const candidate = { ...existing, name: 'Candidate' }
    const conflicts = findPluginConflicts(candidate, [existing])
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(expect.arrayContaining(['plugin-id', 'rule-id', 'translation-key', 'field-alias', 'enum-field', 'resource-id']))
    expect(validatePluginConflicts(candidate, [existing]).ok).toBe(false)
  })

  it('aggregates only enabled, revalidated declarations without reading files or executing code', () => {
    const persistedManifest = JSON.parse(JSON.stringify(VALID_MANIFEST_INPUT)) as PluginManifest
    const disabled = { manifest: persistedManifest, enabled: false }
    const enabled = { manifest: JSON.parse(JSON.stringify(VALID_MANIFEST_INPUT)) as PluginManifest, enabled: true }
    const invalid = { manifest: { ...VALID_MANIFEST_INPUT, script: 'payload.js' }, enabled: true }
    const data = loadEnabledPluginData({ plugins: [disabled, enabled, invalid] })
    expect(data.translations).toEqual([{ en: 'terrainName', zh: 'Terrain' }])
    expect(data.aliases).toEqual([{ alias: 'health', code: 'maxHp' }])
    expect(data.enumExplanations).toEqual({ moveType: { land: 'Land unit' } })
    expect(data.rules.map((rule) => rule.id)).toEqual(['max-hp'])
  })

  it('禁用插件不提供运行时数据，危险能力与非法规则被隔离', () => {
    const raw = {
      plugins: [{
        enabled: true,
        manifest: {
          manifestVersion: 1,
          id: 'safe.plugin',
          version: '1.0.0',
          name: 'Safe plugin',
          capabilities: ['translations', 'rules'],
          translations: { en: { customKey: 'Custom' } },
          rules: { formatVersion: 1, name: 'rules', rules: [{ id: 'safe-rule', title: 'Safe', check: { type: 'required-key', key: 'name' } }] },
          resources: [],
        },
      }, {
        enabled: true,
        manifest: {
          manifestVersion: 1,
          id: 'danger.plugin',
          version: '1.0.0',
          name: 'Danger plugin',
          capabilities: ['translations'],
          translations: { en: { customKey: 'Bad' } },
          resources: [],
          script: 'payload.js',
        },
      }, {
        enabled: false,
        manifest: {
          manifestVersion: 1,
          id: 'disabled.plugin',
          version: '1.0.0',
          name: 'Disabled plugin',
          capabilities: ['translations'],
          translations: { en: { disabledKey: 'Disabled' } },
          resources: [],
        },
      }],
    }
    const data = loadEnabledPluginData(raw)
    expect(data.translations).toEqual([{ en: 'customKey', zh: 'Custom' }])
    expect(data.rules.map((rule) => rule.id)).toEqual(['safe-rule'])
  })
})

describe('M40 renderer adapter 宿主注册表（消费入口）', () => {
  afterEach(() => resetRendererAdaptersForTest())

  const fallback = { commands: [{ type: 'fillRect' as const, x: 0, y: 0, width: 1, height: 1, color: '#000' }] }

  it('未注册插件 id 时直接返回内置回退（不执行任何代码）', async () => {
    const result = await runRendererAdapter('unknown.plugin', { items: [] }, fallback, { timeoutMs: 10 })
    expect(result.usedFallback).toBe(true)
    expect(result.executedPluginId).toBeNull()
    expect(result.result).toBe(fallback)
  })

  it('已注册 adapter 经 executeRendererAdapter 执行并携带场景冻结/回退链', async () => {
    const manifest = validManifest()
    let observedScene: unknown
    registerRendererAdapter({
      pluginId: 'terrain.tools',
      run: (scene) => {
        observedScene = scene
        expect(Object.isFrozen(scene)).toBe(true)
        return { commands: [{ type: 'fillRect', x: 0, y: 0, width: 4, height: 4, color: '#fff' }] }
      },
    })
    expect(registeredAdapterIds()).toEqual(['terrain.tools'])
    const result = await runRendererAdapter('Terrain.Tools', { items: [{ id: 1 }] }, fallback, {
      adapter: manifest.rendererAdapter,
      resources: manifest.resources,
    })
    expect(result.usedFallback).toBe(false)
    expect(result.executedPluginId).toBe('terrain.tools')
    expect(result.result.commands).toHaveLength(1)
    expect(observedScene).toEqual({ items: [{ id: 1 }] })

    // 注销后回到「未注册 → 回退」路径
    unregisterRendererAdapter('terrain.tools')
    const after = await runRendererAdapter('terrain.tools', {}, fallback)
    expect(after.usedFallback).toBe(true)
    expect(after.executedPluginId).toBeNull()
  })

  it('已注册 adapter 抛异常/返回非法结果时统一回退（与直连执行同链）', async () => {
    const manifest = validManifest()
    const options = { adapter: manifest.rendererAdapter, resources: manifest.resources }
    registerRendererAdapter({ pluginId: 'terrain.tools', run: () => { throw new Error('boom') } })
    await expect(runRendererAdapter('terrain.tools', {}, fallback, options)).resolves.toMatchObject({ usedFallback: true, reason: 'exception' })
    registerRendererAdapter({ pluginId: 'terrain.tools', run: () => ({ commands: [{ type: 'execute' }] }) })
    await expect(runRendererAdapter('terrain.tools', {}, fallback, options)).resolves.toMatchObject({ usedFallback: true, reason: 'invalid-result' })
  })
})

function getStatePluginPath(state: ReturnType<typeof createPluginState>): string | undefined {
  return state.plugins[0]?.manifest.resources[0]?.path
}
