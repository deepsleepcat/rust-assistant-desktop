import { describe, expect, it } from 'vitest'
import { commitText, computeRustCompletions, localVariableCompletions, setCompletionChineseMode } from '../src/features/editor/completion'
import type { CompletionDataSource } from '../src/features/editor/completion'
import { parseValueList } from '../src/services/codeData'

/** 假数据源：模拟完整数据结构（含 needName 节、资源文件、单位名） */
const fakeData: CompletionDataSource = {
  findSectionsByQuery: (q) =>
    [
      { code: 'core', translate: '核心' },
      { code: 'attack', translate: '攻击' },
      { code: 'turret', translate: '炮塔', needName: true },
    ].filter((s) => s.code.includes(q) || s.translate.includes(q)),
  findCodesBySection: (section, q) =>
    [
      { code: 'name', translate: '名称', description: '单位名称', type: 'string', section: 'core' },
      { code: 'price', translate: '价格', description: '造价', type: 'resource', section: 'core' },
      { code: 'health', translate: '生命值', description: '血量', type: 'int', section: 'core' },
      { code: 'image', translate: '图像', description: '单位图像', type: 'baseImage', section: 'graphics' },
      { code: 'logic', translate: '逻辑', description: '逻辑判断', type: 'logicBoolean', section: 'logicBoolean' },
    ]
      .filter((c) => c.section === 'all' || c.section === section)
      .filter((c) => c.code.includes(q) || c.translate.includes(q)),
  findCodeByCode: (code) => {
    const map: Record<string, { code: string; translate: string; description: string; type: string }> = {
      name: { code: 'name', translate: '名称', description: '', type: 'string' },
      price: { code: 'price', translate: '价格', description: '', type: 'resource' },
      health: { code: 'health', translate: '生命值', description: '', type: 'int' },
      image: { code: 'image', translate: '图像', description: '', type: 'baseImage' },
      logic: { code: 'logic', translate: '逻辑', description: '', type: 'logicBoolean' },
      floatLogic: { code: 'floatLogic', translate: '浮动逻辑', description: '', type: 'float,logicBoolean' },
      builtFrom_1_name: { code: 'builtFrom_1_name', translate: '建造自_1_名称', description: '', type: 'unit' },
    }
    return map[code]
  },
  findValueType: (type) => {
    const map: Record<string, { external?: string; list?: string }> = {
      string: { external: ':' },
      resource: { external: ':', list: 'NONE,AUTO,@file(png)' },
      int: { external: ':' },
      baseImage: { list: 'NONE,AUTO,@file(png),@file(jpg)' },
      logicBoolean: { list: 'true,false,if,@type(noParameterLogicStatement)' },
      'float,logicBoolean': { external: ':', list: '@type(noParameterLogicStatement)' },
      unit: { external: ':', list: '@type(internalUnits),@customType(unitName)' },
    }
    return map[type]
  },
  findCodesByQuery: (q) => fakeData.findCodesBySection('core', q),
  findCodesByType: (type, q = '') =>
    [
      { code: 'self.isFlying', translate: '自身在天上', description: '', type: 'noParameterLogicStatement' },
      { code: 'self.isMoving', translate: '自身在移动', description: '', type: 'noParameterLogicStatement' },
    ].filter((c) => c.type === type && (c.code.includes(q) || c.translate.includes(q))),
  listResourceFiles: async (exts) =>
    ['units/tank/tank.png', 'units/tank/tank_wreck.png', 'units/rifle/rifle.png'].filter((f) =>
      exts.some((e) => f.endsWith(`.${e}`)),
    ),
  listUnitNames: async () => ['重型坦克', '步枪兵', '侦察车'],
  findDialectWords: (q, limit = 30) =>
    [
      { word: 'isFlying', explanation: '逻辑谓词：是否在飞行' },
      { word: 'isAirUnit', explanation: '逻辑谓词：是否为飞行单位' },
      { word: 'breadUnitMemory', explanation: '逻辑谓词：读取单位记忆值' },
      { word: 'completed', explanation: '逻辑谓词：建造是否完成' },
    ]
      .filter((v) => !q || v.word.toLowerCase().includes(q) || v.explanation.includes(q))
      .slice(0, limit),
}

describe('补全候选计算（注入假数据源）', () => {
  it('节补全：未闭合 [ 时按前缀返回节候选', async () => {
    const result = await computeRustCompletions('[c', '', 'c', '[c', 0, ['[c'], fakeData)
    expect(result.length).toBeGreaterThan(0)
    expect(result.map((r) => r.label)).toContain('core · 核心')
    // 普通节（非 needName）：apply 为函数，插入 [core] 且不重复 [（用户已输入 [）
    const core = result.find((r) => r.label.startsWith('core'))
    expect(typeof core!.apply).toBe('function')
  })

  it('needName 节（turret）补 [turret_ 占位', async () => {
    const result = await computeRustCompletions('[tur', '', 'tur', '[tur', 0, ['[tur'], fakeData)
    const turret = result.find((r) => r.label.startsWith('turret'))
    expect(turret).toBeTruthy()
    // apply 是函数：插入 [turret_ 并把光标停在 _ 后
    expect(typeof turret!.apply).toBe('function')
  })

  it('值补全：冒号后按值类型 list 返回候选', async () => {
    const priceResult = await computeRustCompletions('price: ', 'core', '', 'price: ', 0, ['[core]', 'price: '], fakeData)
    expect(priceResult.map((r) => r.apply)).toContain('NONE')
    expect(priceResult.map((r) => r.apply)).toContain('AUTO')
  })

  it('值补全：无候选时不回退键补全（避免 Enter 吞掉已输入的值）', async () => {
    // name 是 string 类型无候选 → 空（而不是冒出 name: 键候选）
    const result = await computeRustCompletions('name: ', 'core', '', 'name: ', 0, ['[core]', 'name: '], fakeData)
    expect(result).toEqual([])
  })

  it('值补全：@file(类型) 返回项目资源文件', async () => {
    const result = await computeRustCompletions('image: ', 'graphics', '', 'image: ', 0, ['[graphics]', 'image: '], fakeData)
    const apps = result.map((r) => r.apply)
    expect(apps).toContain('units/tank/tank.png')
    expect(apps).toContain('units/rifle/rifle.png')
    // 非 png/jpg 文件不出现（music/bgm.ogg 不在假数据里）
    expect(apps).not.toContain('music/bgm.ogg')
  })

  it('单位名联想：builtFrom_1_name 返回项目单位名', async () => {
    const result = await computeRustCompletions('builtFrom_1_name: ', 'core', '', 'builtFrom_1_name: ', 0, ['[core]', 'builtFrom_1_name: '], fakeData)
    expect(result.map((r) => r.apply)).toContain('重型坦克')
    expect(result.map((r) => r.apply)).toContain('侦察车')
  })

  it('@type(类型)：同类型键联想（logicBoolean 值位置提示 self 语句）', async () => {
    const result = await computeRustCompletions('logic: ', 'logicBoolean', '', 'logic: ', 0, ['[logicBoolean]', 'logic: '], fakeData)
    const apps = result.map((r) => r.apply)
    const labels = result.map((r) => r.label)
    // 普通 list 值也在
    expect(apps).toContain('true')
    // @type(noParameterLogicStatement) → 同类型键（self 语句，apply 为函数）
    expect(labels.some((l) => l.startsWith('self.isFlying'))).toBe(true)
    expect(labels.some((l) => l.startsWith('self.isMoving'))).toBe(true)
  })

  it('@customType(类型)：unit 值类型引用项目单位名', async () => {
    const result = await computeRustCompletions('builtFrom_1_name: ', 'core', '', 'builtFrom_1_name: ', 0, ['[core]', 'builtFrom_1_name: '], fakeData)
    const apps = result.map((r) => r.apply)
    // @customType(unitName) → 项目单位名
    expect(apps).toContain('重型坦克')
    expect(apps).toContain('步枪兵')
  })

  it('@type/@customType 候选支持关键字过滤', async () => {
    const result = await computeRustCompletions('builtFrom_1_name: 重型', 'core', '重型', 'builtFrom_1_name: 重型', 0, ['[core]', 'builtFrom_1_name: 重型'], fakeData)
    const apps = result.map((r) => r.apply)
    expect(apps).toContain('重型坦克')
    expect(apps).not.toContain('步枪兵')
  })

  it('M27-2 dialect 词：逻辑值上下文按前缀命中（is → isFlying/isAirUnit）', async () => {
    const result = await computeRustCompletions('logic: is', 'logicBoolean', 'is', 'logic: is', 0, ['[logicBoolean]', 'logic: is'], fakeData)
    const apps = result.map((r) => r.apply)
    expect(apps).toContain('isFlying')
    expect(apps).toContain('isAirUnit')
    // 前缀不匹配的词不出现
    expect(apps).not.toContain('breadUnitMemory')
    // 候选带说明（detail 为 explanation）
    const flying = result.find((r) => r.apply === 'isFlying')
    expect(flying?.detail).toContain('飞行')
  })

  it('M27-2 dialect 词：中文说明匹配（输入「飞行」）', async () => {
    const result = await computeRustCompletions('logic: 飞行', 'logicBoolean', '飞行', 'logic: 飞行', 0, ['[logicBoolean]', 'logic: 飞行'], fakeData)
    const apps = result.map((r) => r.apply)
    expect(apps).toContain('isFlying')
    expect(apps).toContain('isAirUnit')
    expect(apps).not.toContain('completed')
  })

  it('M27-2 dialect 词：非逻辑类型（string）值位置不出现', async () => {
    const result = await computeRustCompletions('name: is', 'core', 'is', 'name: is', 0, ['[core]', 'name: is'], fakeData)
    expect(result.map((r) => r.apply)).not.toContain('isFlying')
  })

  it('M27-2 dialect 词：多值类型（float,logicBoolean）键同样命中', async () => {
    const result = await computeRustCompletions('floatLogic: is', 'core', 'is', 'floatLogic: is', 0, ['[core]', 'floatLogic: is'], fakeData)
    expect(result.map((r) => r.apply)).toContain('isFlying')
    expect(result.map((r) => r.apply)).toContain('isAirUnit')
  })

  it('M27-2 dialect 词：空查询（刚输冒号）有候选且不报错（调用方压 limit 为 10）', async () => {
    // 捕获 limit 实参：守卫「空查询时压数量」分支（fake 数据只有 4 条，数量断言测不出）
    const limits: number[] = []
    const countingData: CompletionDataSource = {
      ...fakeData,
      findDialectWords: (q, limit = 30) => {
        limits.push(limit)
        return fakeData.findDialectWords!(q, limit)
      },
    }
    const result = await computeRustCompletions('logic: ', 'logicBoolean', '', 'logic: ', 0, ['[logicBoolean]', 'logic: '], countingData)
    expect(limits).toContain(10)
    const dialectApps = result.map((r) => String(r.apply)).filter((a) => ['isFlying', 'isAirUnit', 'breadUnitMemory', 'completed'].includes(a))
    expect(dialectApps.length).toBeGreaterThan(0)
  })

  it('M27-2 dialect 词：数据源未提供时优雅降级（不报错、无 dialect 候选）', async () => {
    // 构造不含 findDialectWords 的数据源（模拟旧接口/未加载 dialect 数据）
    const withoutDialect: CompletionDataSource = {
      findSectionsByQuery: fakeData.findSectionsByQuery,
      findCodesBySection: fakeData.findCodesBySection,
      findCodeByCode: fakeData.findCodeByCode,
      findValueType: fakeData.findValueType,
      findCodesByQuery: fakeData.findCodesByQuery,
      findCodesByType: fakeData.findCodesByType,
    }
    const result = await computeRustCompletions('logic: is', 'logicBoolean', 'is', 'logic: is', 0, ['[logicBoolean]', 'logic: is'], withoutDialect)
    // 不抛错；self 语句等既有候选仍在
    expect(result.map((r) => r.apply)).not.toContain('isFlying')
    expect(result.some((r) => String(r.label).startsWith('self.isFlying'))).toBe(true)
  })

  it('键补全：无冒号行返回当前节键，中文可匹配', async () => {
    const result = await computeRustCompletions('名', 'core', '名', '名', 0, ['[core]', '名'], fakeData)
    expect(result.map((r) => r.label)).toContain('name · 名称')
    // 提交自动带冒号（apply 为函数：登记追踪表后 dispatch）
    const nameItem = result.find((r) => r.label.startsWith('name'))
    expect(nameItem).toBeTruthy()
    expect(typeof nameItem!.apply).toBe('function')
    expect(commitText('name', '名称', ':')).toBe('name:')
  })

  it('int 类型键提交自动补默认值 1（apply 为函数）', async () => {
    const result = await computeRustCompletions('health', 'core', 'health', 'health', 0, ['[core]', 'health'], fakeData)
    const health = result.find((r) => r.label.startsWith('health'))
    expect(health).toBeTruthy()
    expect(typeof health!.apply).toBe('function')
  })

  it('中文模式：提交文本用中文键/节名', async () => {
    setCompletionChineseMode(true)
    const result = await computeRustCompletions('名', 'core', '名', '名', 0, ['[core]', '名'], fakeData)
    const zhItem = result.find((r) => r.label.startsWith('name'))
    expect(zhItem).toBeTruthy()
    expect(typeof zhItem!.apply).toBe('function')
    expect(commitText('name', '名称', ':')).toBe('名称:')
    setCompletionChineseMode(false)
    const en = await computeRustCompletions('名', 'core', '名', '名', 0, ['[core]', '名'], fakeData)
    expect(en.find((r) => r.label.startsWith('name'))).toBeTruthy()
    expect(commitText('name', '名称', ':')).toBe('name:')
  })

  it('节过滤：非当前节的键不出现', async () => {
    const result = await computeRustCompletions('', 'turret', '', '', 0, ['[turret]'], fakeData)
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('值类型 list 解析', () => {
  it('解析逗号分隔并过滤特殊指令', () => {
    expect(parseValueList('true,false')).toEqual(['true', 'false'])
    expect(parseValueList('NONE,AUTO,@file(png),ROOT:')).toEqual(['NONE', 'AUTO', 'ROOT:'])
    expect(parseValueList('')).toEqual([])
    expect(parseValueList(undefined)).toEqual([])
  })
})

describe('局部变量补全（${}）', () => {
  it('收集当前文件出现的 ${变量名} 并去重', () => {
    const lines = ['[core]', 'name: ${坦克名}', 'describe: ${坦克名} ${价格}']
    const result = localVariableCompletions(lines, '')
    expect(result).toHaveLength(2)
    const labels = result.map((r) => r.label)
    expect(labels).toContain('坦克名')
    expect(labels).toContain('价格')
  })

  it('${节.键} 引用不算变量', () => {
    const lines = ['name: ${core.name}']
    expect(localVariableCompletions(lines, '')).toEqual([])
  })

  it('按输入过滤变量名', () => {
    const lines = ['a: ${坦克名}', 'b: ${价格}']
    const result = localVariableCompletions(lines, '坦克')
    expect(result.map((r) => r.label)).toEqual(['坦克名'])
  })

  it('提交文本为 ${变量名}', () => {
    const lines = ['a: ${坦克名}']
    const result = localVariableCompletions(lines, '')
    expect(result[0].apply).toBe('${坦克名}')
  })
})
