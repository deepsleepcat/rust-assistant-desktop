/**
 * 单位表单字段元数据（M14，P1 任务 4 可视化单位编辑器）：
 * Core/Graphics/Attack/Movement/Turret 五组常用字段的表单定义——
 * 类型、默认值、必填/推荐标注、说明、枚举选项。
 * 数据来源：官方单位文件实际键（W:\steam\steamapps\common\Rusted Warfare\assets\units）
 * 与代码表 code.json 的说明合并。
 */

export type UnitFieldType = 'number' | 'text' | 'boolean' | 'enum' | 'resource'

export interface UnitFieldDef {
  /** 英文键名（写回文件的键） */
  key: string
  /** 中文显示名 */
  label: string
  type: UnitFieldType
  /** 必填（缺失即报错） */
  required?: boolean
  /** 推荐（缺失给提示） */
  recommended?: boolean
  /** 默认值（新单位生成/缺失时展示） */
  defaultValue?: string
  /** 中文说明（悬停展示） */
  description: string
  /** enum 选项（值 → 中文） */
  options?: Record<string, string>
  /** 数字最小/最大值（非法值即时提示） */
  min?: number
  max?: number
  /** text 类型正则校验（patternMessage 为不匹配时的提示） */
  pattern?: RegExp
  patternMessage?: string
  /** resource 类型允许的扩展名（小写） */
  resourceExts?: string[]
}

export interface UnitFieldGroup {
  /** 节名（[core] 等） */
  section: string
  /** 中文节名 */
  label: string
  fields: UnitFieldDef[]
}

/** movementType 枚举（value_type.json movementType.list） */
const MOVEMENT_TYPES: Record<string, string> = {
  NONE: '无（固定）',
  LAND: '陆地',
  BUILDING: '建筑（固定）',
  AIR: '空中',
  WATER: '水面',
  HOVER: '悬浮',
  OVER_CLIFF: '可越悬崖',
  OVER_CLIFF_WATER: '可越悬崖+水面',
}

const BOOLEAN_OPTIONS: Record<string, string> = { true: '是', false: '否' }

/** 图片资源扩展名 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
/** 单位表单五组字段（按官方单位文件常用键编排） */
export const UNIT_FORM_GROUPS: UnitFieldGroup[] = [
  {
    section: 'core',
    label: '核心 Core',
    fields: [
      { key: 'name', label: '单位名（唯一标识）', type: 'text', required: true, description: '单位内部唯一标识，小驼峰命名（如 myTank）；显示名用 displayLocaleKey' },
      { key: 'displayLocaleKey', label: '显示名键', type: 'text', description: '游戏内显示名称的本地化键（如 myTank 或中文字符串）' },
      { key: 'price', label: '造价', type: 'number', defaultValue: '300', min: 0, description: '建造花费的资源数（免费单位用 0）' },
      { key: 'maxHp', label: '生命值', type: 'number', required: true, defaultValue: '500', min: 1, description: '最大生命值，必须为正数' },
      { key: 'mass', label: '质量', type: 'number', defaultValue: '500', min: 1, description: '单位质量，影响碰撞与冲击' },
      { key: 'radius', label: '半径', type: 'number', defaultValue: '10', min: 1, description: '单位碰撞/选中半径（像素）' },
      { key: 'techLevel', label: '科技等级', type: 'number', defaultValue: '1', min: 1, max: 4, description: '科技等级（1-4，影响建造解锁）' },
      { key: 'buildSpeed', label: '建造速度', type: 'text', defaultValue: '20s', description: '建造耗时（如 20s = 20 秒）' },
      { key: 'isBio', label: '生物单位', type: 'enum', options: BOOLEAN_OPTIONS, defaultValue: 'false', description: '是否为生物单位（受治疗/感染类效果影响）' },
    ],
  },
  {
    section: 'graphics',
    label: '图形 Graphics',
    fields: [
      { key: 'image', label: '单位图片', type: 'resource', recommended: true, resourceExts: IMAGE_EXTS, description: '单位本体图片（相对单位目录）' },
      { key: 'image_wreak', label: '残骸图片', type: 'resource', resourceExts: IMAGE_EXTS, description: '单位被摧毁后的残骸图片（可留空）' },
      { key: 'image_turret', label: '炮塔图片', type: 'resource', resourceExts: IMAGE_EXTS, description: '炮塔图片（NONE = 无炮塔）' },
      { key: 'image_shadow', label: '阴影图片', type: 'resource', resourceExts: IMAGE_EXTS, description: '单位阴影（AUTO = 自动生成）' },
      { key: 'shadowOffsetX', label: '阴影偏移 X', type: 'number', defaultValue: '0', description: '阴影水平偏移（像素）' },
      { key: 'shadowOffsetY', label: '阴影偏移 Y', type: 'number', defaultValue: '0', description: '阴影垂直偏移（像素）' },
      { key: 'drawLayer', label: '绘制层', type: 'enum', options: { ground: '地面', ground2: '地面 2', air: '空中', underwater: '水下', bottom: '底层', top: '顶层', experimentals: '实验层', wreaks: '残骸层' }, description: '单位所在绘制层（决定与地面单位的遮挡关系）' },
      { key: 'total_frames', label: '总帧数', type: 'number', defaultValue: '1', min: 1, description: '单位动画总帧数（多帧动画时使用）' },
    ],
  },
  {
    section: 'attack',
    label: '攻击 Attack',
    fields: [
      { key: 'canAttack', label: '可以攻击', type: 'enum', options: BOOLEAN_OPTIONS, defaultValue: 'true', description: '是否具备攻击能力' },
      { key: 'maxAttackRange', label: '最大攻击距离', type: 'number', defaultValue: '200', min: 1, description: '攻击最大射程（像素）' },
      { key: 'shootDelay', label: '射击间隔', type: 'text', defaultValue: '20', pattern: /^\d+(\.\d+)?s?$/, patternMessage: '格式：数字或数字+s（如 20 或 5s）', description: '两次攻击之间的间隔（帧或秒，如 20 或 5s）' },
      { key: 'turretTurnSpeed', label: '炮塔转向速度', type: 'number', defaultValue: '1', min: 0, description: '炮塔旋转速度' },
      { key: 'turretSize', label: '炮塔尺寸', type: 'number', defaultValue: '10', min: 1, description: '炮塔碰撞/显示尺寸' },
    ],
  },
  {
    section: 'movement',
    label: '移动 Movement',
    fields: [
      { key: 'movementType', label: '移动类型', type: 'enum', defaultValue: 'LAND', options: MOVEMENT_TYPES, description: '单位移动方式（空中/陆地/水面等）' },
      { key: 'moveSpeed', label: '移动速度', type: 'number', defaultValue: '1', min: 0, description: '移动速度（0 = 该形态不可移动）' },
      { key: 'moveAccelerationSpeed', label: '加速度', type: 'number', defaultValue: '0.02', min: 0, description: '起步加速度' },
      { key: 'moveDecelerationSpeed', label: '减速度', type: 'number', defaultValue: '0.02', min: 0, description: '停止减速度' },
      { key: 'maxTurnSpeed', label: '转向速度', type: 'number', defaultValue: '1', min: 0, description: '最大转向速度' },
      { key: 'turnAcceleration', label: '转向加速度', type: 'number', defaultValue: '0.03', min: 0, description: '转向加速度' },
    ],
  },
  {
    section: 'turret',
    label: '炮塔 Turret',
    fields: [
      { key: 'x', label: '炮塔 X 坐标', type: 'number', defaultValue: '0', description: '炮塔相对单位中心的水平偏移（像素）' },
      { key: 'y', label: '炮塔 Y 坐标', type: 'number', defaultValue: '0', description: '炮塔相对单位中心的垂直偏移（像素）' },
      { key: 'projectile', label: '弹体', type: 'text', recommended: true, defaultValue: '1', description: '弹体引用（编号 1-3 或自定义弹体名，需定义 [projectile_xxx] 节）' },
      { key: 'size', label: '炮塔尺寸', type: 'number', defaultValue: '10', min: 1, description: '炮塔显示尺寸' },
      { key: 'idleDir', label: '待机朝向', type: 'number', defaultValue: '0', description: '待机时炮塔朝向（角度）' },
      { key: 'shoot_sound', label: '开火音效', type: 'text', description: '开火音效码名（如 missile_fire / cannon_firing）或项目内音效文件路径；NONE = 无声' },
    ],
  },
]

/** 按键查字段定义（跨组；大小写不敏感） */
export function findUnitField(key: string): UnitFieldDef | undefined {
  const lower = key.toLowerCase()
  for (const g of UNIT_FORM_GROUPS) {
    const f = g.fields.find((f) => f.key.toLowerCase() === lower)
    if (f) return f
  }
  return undefined
}

/** 按节名找组：精确匹配；炮塔组前缀匹配（官方节名是 [turret_1]/[turret_2]/[turret_body] 等编号/命名变体） */
export function findUnitGroup(section: string): UnitFieldGroup | undefined {
  const lower = section.toLowerCase()
  const exact = UNIT_FORM_GROUPS.find((g) => g.section.toLowerCase() === lower)
  if (exact) return exact
  if (/^turret(?:_|$)/.test(lower)) return UNIT_FORM_GROUPS.find((g) => g.section === 'turret')
  return undefined
}
